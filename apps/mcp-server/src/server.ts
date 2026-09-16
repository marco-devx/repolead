import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { CodeSymbol } from '@repolead/domain';
import type { KnowledgeStore } from '@repolead/knowledge-store';
import {
  QdrantRestClient,
  TeiEmbeddingsClient,
  TeiRerankerClient,
  hybridSearch,
} from '@repolead/retrieval';

const PREVIEW_CHARS = 300;
const EVIDENCE_HINT =
  'Los textos son previews; usa get_evidence para el código exacto que respalda una conclusión.';

export interface ServedRepo {
  name: string;
  store: KnowledgeStore;
}

interface RepoContext {
  name: string;
  store: KnowledgeStore;
  snapshotId: string;
  rootPath: string;
}

/** Contrato de tokens (patrón engram): previews cortos + get_evidence para el detalle. */
function preview(text: string): string {
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}… [preview]` : text;
}

function textResult(payload: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 1) }] };
}

function findSymbolIn(context: RepoContext, name: string): CodeSymbol | null {
  const symbols = context.store.listSymbols(context.snapshotId);
  return (
    symbols.find((symbol) => symbol.qualifiedName === name) ??
    symbols.find((symbol) => symbol.qualifiedName.endsWith(`.${name}`)) ??
    symbols.find((symbol) => symbol.qualifiedName.toLowerCase() === name.toLowerCase()) ??
    null
  );
}

async function reachable(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
}

/**
 * Servidor MCP sobre una o varias bases de RepoLead. Con varios repos, cada
 * tool acepta `repo`; cuando el objetivo es inequívoco (un solo repo, o el
 * símbolo/módulo existe en uno solo) se resuelve sin pedirlo.
 */
export interface ServerOptions {
  /** false = modo producto: nunca se sirve código fuente crudo (get_evidence
   * devuelve solo los metadatos y excerpts persistidos en la base). */
  exposeSource?: boolean;
}

export function createServer(repos: ServedRepo[], options: ServerOptions = {}): McpServer {
  const exposeSource = options.exposeSource !== false;
  const contexts: RepoContext[] = [];
  for (const { name, store } of repos) {
    const snapshot = store.getLatestSnapshot();
    if (!snapshot) {
      continue;
    }
    const repository = store.getRepository(snapshot.repositoryId);
    contexts.push({
      name,
      store,
      snapshotId: snapshot.id,
      rootPath: repository?.rootPath ?? process.cwd(),
    });
  }
  if (contexts.length === 0) {
    throw new Error('Ninguna base tiene snapshots: corre `repolead scan` primero.');
  }

  const byName = new Map(contexts.map((context) => [context.name, context]));
  const repoNames = [...byName.keys()].join(', ');
  const single = contexts.length === 1 ? contexts[0]! : null;

  const server = new McpServer({ name: 'repolead', version: '0.2.0' });

  const repoParam = {
    repo: z.string().optional().describe(`repo objetivo (disponibles: ${repoNames})`),
  };

  type Resolved = RepoContext | { error: string } | null;
  const resolveRepo = (repo?: string): Resolved => {
    if (repo) {
      return byName.get(repo) ?? { error: `repo desconocido: ${repo}. Disponibles: ${repoNames}` };
    }
    return single;
  };
  const isError = (value: Resolved): value is { error: string } =>
    value !== null && 'error' in value;

  server.registerTool(
    'repo_overview',
    {
      description:
        'Visión técnica general: stats, módulos y Repository Brief. Sin `repo` y con varios repos servidos, lista todos.',
      inputSchema: repoParam,
    },
    ({ repo }) => {
      const resolved = resolveRepo(repo);
      if (isError(resolved)) {
        return textResult(resolved);
      }
      if (!resolved) {
        return textResult({
          repos: contexts.map((context) => ({
            repo: context.name,
            stats: context.store.getCounts(context.snapshotId),
            modules: context.store.listModules(context.snapshotId).map((module) => module.name),
          })),
          hint: 'pasa `repo` para el detalle y el Repository Brief de uno',
        });
      }
      const brief = resolved.store.db
        .prepare(
          "SELECT content_json FROM summaries WHERE snapshot_id = ? AND level = 'repository' ORDER BY created_at DESC LIMIT 1",
        )
        .get(resolved.snapshotId) as { content_json: string } | undefined;
      return textResult({
        repository: resolved.name,
        stats: resolved.store.getCounts(resolved.snapshotId),
        modules: resolved.store.listModules(resolved.snapshotId).map((module) => module.name),
        brief: brief ? (JSON.parse(brief.content_json) as unknown) : 'sin analizar: corre `repolead analyze`',
      });
    },
  );

  server.registerTool(
    'module_context',
    {
      description: 'Dossier de un módulo: responsabilidad, API, riesgos y findings confirmados.',
      inputSchema: { module: z.string(), ...repoParam },
    },
    ({ module: moduleName, repo }) => {
      let resolved = resolveRepo(repo);
      if (isError(resolved)) {
        return textResult(resolved);
      }
      if (!resolved) {
        const owners = contexts.filter((context) =>
          context.store.listModules(context.snapshotId).some((entry) => entry.name === moduleName),
        );
        if (owners.length !== 1) {
          return textResult({
            error:
              owners.length === 0
                ? `módulo desconocido en todos los repos: ${moduleName}`
                : `módulo ambiguo (${owners.map((owner) => owner.name).join(', ')}): pasa \`repo\``,
          });
        }
        resolved = owners[0]!;
      }
      const module = resolved.store
        .listModules(resolved.snapshotId)
        .find((entry) => entry.name === moduleName);
      if (!module) {
        return textResult({ error: `módulo desconocido en ${resolved.name}: ${moduleName}` });
      }
      const dossier = resolved.store.db
        .prepare(
          "SELECT content_json FROM summaries WHERE snapshot_id = ? AND subject_id = ? AND level = 'module' ORDER BY created_at DESC LIMIT 1",
        )
        .get(resolved.snapshotId, module.id) as { content_json: string } | undefined;
      const findings = resolved.store
        .getFindings(resolved.snapshotId, 'confirmed')
        .filter((finding) => finding.module === module.id);
      return textResult({
        repo: resolved.name,
        module: module.name,
        path: module.path,
        dossier: dossier ? (JSON.parse(dossier.content_json) as unknown) : 'sin analizar',
        findings: findings.map((finding) => ({
          ruleId: finding.ruleId,
          severity: finding.severity,
          claim: preview(finding.claim),
          findingId: finding.id,
        })),
        hint: EVIDENCE_HINT,
      });
    },
  );

  const locateSymbol = (
    symbolName: string,
    repo?: string,
  ): { context: RepoContext; symbol: CodeSymbol } | { error: string } => {
    const resolved = resolveRepo(repo);
    if (isError(resolved)) {
      return resolved;
    }
    if (resolved) {
      const symbol = findSymbolIn(resolved, symbolName);
      return symbol
        ? { context: resolved, symbol }
        : { error: `símbolo desconocido en ${resolved.name}: ${symbolName}` };
    }
    const matches = contexts
      .map((context) => ({ context, symbol: findSymbolIn(context, symbolName) }))
      .filter((entry): entry is { context: RepoContext; symbol: CodeSymbol } => entry.symbol !== null);
    if (matches.length === 1) {
      return matches[0]!;
    }
    return {
      error:
        matches.length === 0
          ? `símbolo desconocido en todos los repos: ${symbolName}`
          : `símbolo ambiguo (${matches.map((match) => match.context.name).join(', ')}): pasa \`repo\``,
    };
  };

  server.registerTool(
    'symbol_context',
    {
      description: 'Ficha de un símbolo: ubicación, firma, relaciones entrantes y salientes.',
      inputSchema: { symbol: z.string(), ...repoParam },
    },
    ({ symbol: symbolName, repo }) => {
      const located = locateSymbol(symbolName, repo);
      if ('error' in located) {
        return textResult(located);
      }
      const { context, symbol } = located;
      const graph = context.store.loadGraph(context.snapshotId);
      const describe = (id: string): string => graph.symbols.get(id)?.qualifiedName ?? id;
      const ordered = (edges: { edgeType: string; confidence: number }[]) =>
        [...edges].sort(
          (left, right) =>
            Number(right.edgeType === 'CALLS') - Number(left.edgeType === 'CALLS') ||
            right.confidence - left.confidence,
        );
      const incomingAll = ordered(graph.incoming.get(symbol.id) ?? []) as typeof graph.incoming extends Map<string, infer E> ? E : never;
      const outgoingAll = ordered(graph.outgoing.get(symbol.id) ?? []) as typeof incomingAll;
      return textResult({
        ...(incomingAll.length > 20 || outgoingAll.length > 20
          ? {
              truncation: `showing 20 of ${incomingAll.length} incoming and 20 of ${outgoingAll.length} outgoing relations; use find_callers with transitiveDepth for the full caller set`,
            }
          : {}),
        repo: context.name,
        symbol: symbol.qualifiedName,
        kind: symbol.kind,
        signature: symbol.signature,
        location: `${symbol.path}:${symbol.startLine}-${symbol.endLine}`,
        incoming: incomingAll
          .slice(0, 20)
          .map((edge) => `${describe(edge.sourceId)} —${edge.edgeType}→ (${edge.analyzer})`),
        outgoing: outgoingAll
          .slice(0, 20)
          .map((edge) => `—${edge.edgeType}→ ${describe(edge.targetId)} (${edge.analyzer})`),
        hint: EVIDENCE_HINT,
      });
    },
  );

  server.registerTool(
    'find_callers',
    {
      description: 'Quién llama a un símbolo, con profundidad transitiva opcional.',
      inputSchema: {
        symbol: z.string(),
        transitiveDepth: z.number().int().min(1).max(5).optional().describe('default 1'),
        ...repoParam,
      },
    },
    ({ symbol: symbolName, transitiveDepth, repo }) => {
      const located = locateSymbol(symbolName, repo);
      if ('error' in located) {
        return textResult(located);
      }
      const { context, symbol } = located;
      const graph = context.store.loadGraph(context.snapshotId);
      const layers: string[][] = [];
      let frontier = new Set([symbol.id]);
      const seen = new Set(frontier);
      for (let level = 0; level < (transitiveDepth ?? 1); level += 1) {
        const next = new Set<string>();
        for (const id of frontier) {
          for (const edge of graph.incoming.get(id) ?? []) {
            if (edge.edgeType === 'CALLS' && !seen.has(edge.sourceId)) {
              seen.add(edge.sourceId);
              next.add(edge.sourceId);
            }
          }
        }
        if (next.size === 0) {
          break;
        }
        layers.push([...next].map((id) => graph.symbols.get(id)?.qualifiedName ?? id));
        frontier = next;
      }
      return textResult({ repo: context.name, symbol: symbol.qualifiedName, callersByDepth: layers });
    },
  );

  server.registerTool(
    'architecture_findings',
    {
      description: 'Findings confirmados del policy engine. Sin `repo`, agrega los de todos.',
      inputSchema: {
        severity: z.array(z.string()).optional().describe('p. ej. ["high", "critical"]'),
        module: z.string().optional(),
        ...repoParam,
      },
    },
    ({ severity, module: moduleName, repo }) => {
      const resolved = resolveRepo(repo);
      if (isError(resolved)) {
        return textResult(resolved);
      }
      const targets = resolved ? [resolved] : contexts;
      const findings = targets.flatMap((context) => {
        const module = moduleName
          ? context.store.listModules(context.snapshotId).find((entry) => entry.name === moduleName)
          : null;
        return context.store
          .getFindings(context.snapshotId, 'confirmed')
          .filter((finding) => !severity || severity.includes(finding.severity))
          .filter((finding) => !moduleName || (module && finding.module === module.id))
          .map((finding) => ({
            repo: context.name,
            findingId: finding.id,
            ruleId: finding.ruleId,
            severity: finding.severity,
            confidence: finding.confidence,
            claim: preview(finding.claim),
          }));
      });
      return textResult({ findings, hint: EVIDENCE_HINT });
    },
  );

  server.registerTool(
    'get_evidence',
    {
      description:
        'Código exacto que respalda una conclusión: evidencia de un finding (findingId) o un rango de archivo (path + líneas).',
      inputSchema: {
        findingId: z.string().optional(),
        path: z.string().optional(),
        startLine: z.number().int().optional(),
        endLine: z.number().int().optional(),
        ...repoParam,
      },
    },
    ({ findingId, path, startLine, endLine, repo }) => {
      const readRange = (
        context: RepoContext,
        filePath: string,
        start: number | null,
        end: number | null,
      ): string => {
        if (!exposeSource) {
          return '(source access disabled on this server)';
        }
        try {
          const lines = readFileSync(join(context.rootPath, filePath), 'utf8').split('\n');
          const from = Math.max((start ?? 1) - 1, 0);
          const to = Math.min(end ?? from + 20, lines.length);
          return lines
            .slice(from, to)
            .map((line, index) => `${from + index + 1}\t${line}`)
            .join('\n');
        } catch {
          return '(archivo no disponible en el working tree actual)';
        }
      };
      if (findingId) {
        for (const context of contexts) {
          const evidence = context.store.getEvidence(findingId);
          if (evidence.length > 0) {
            return textResult(
              evidence.map((item) => ({
                repo: context.name,
                path: item.path,
                lines: item.startLine ? `${item.startLine}-${item.endLine ?? item.startLine}` : null,
                excerpt: item.excerpt,
                source: readRange(context, item.path, item.startLine, item.endLine),
              })),
            );
          }
        }
        return textResult({ error: `sin evidencia para ${findingId}` });
      }
      if (path) {
        if (!exposeSource) {
          return textResult({ error: 'source access disabled on this server' });
        }
        const resolved = resolveRepo(repo);
        if (isError(resolved)) {
          return textResult(resolved);
        }
        if (!resolved) {
          return textResult({ error: `pasa \`repo\` para leer un path (disponibles: ${repoNames})` });
        }
        return textResult({
          repo: resolved.name,
          path,
          source: readRange(resolved, path, startLine ?? null, endLine ?? null),
        });
      }
      return textResult({ error: 'pasa findingId o path' });
    },
  );

  server.registerTool(
    'search',
    {
      description:
        'Búsqueda híbrida de símbolos (FTS5 + vectores + grafo), también en español. Sin `repo`, busca en todos los repos servidos.',
      inputSchema: {
        query: z.string(),
        limit: z.number().int().min(1).max(20).optional(),
        ...repoParam,
      },
    },
    async ({ query, limit, repo }) => {
      const resolved = resolveRepo(repo);
      if (isError(resolved)) {
        return textResult(resolved);
      }
      const targets = resolved ? [resolved] : contexts;
      const tei = process.env['REPOLEAD_TEI_URL'] ?? 'http://localhost:8080';
      const qdrant = process.env['REPOLEAD_QDRANT_URL'] ?? 'http://localhost:6333';
      const reranker = process.env['REPOLEAD_RERANKER_URL'] ?? 'http://localhost:8081';
      const [teiUp, qdrantUp, rerankerUp] = await Promise.all([
        reachable(`${tei}/health`),
        reachable(`${qdrant}/healthz`),
        reachable(`${reranker}/health`),
      ]);
      const perRepo = await Promise.all(
        targets.map(async (context) => {
          const hits = await hybridSearch({
            store: context.store,
            snapshotId: context.snapshotId,
            collection: 'repolead-symbols',
            query,
            embeddings: teiUp ? new TeiEmbeddingsClient(tei) : null,
            qdrant: qdrantUp ? new QdrantRestClient(qdrant) : null,
            reranker: rerankerUp ? new TeiRerankerClient(reranker) : null,
            limit: limit ?? 8,
          });
          return hits.map((hit) => ({
            repo: context.name,
            symbol: hit.symbol.qualifiedName,
            kind: hit.symbol.kind,
            location: `${hit.symbol.path}:${hit.symbol.startLine}-${hit.symbol.endLine}`,
            score: hit.score,
            sources: hit.sources,
          }));
        }),
      );
      const all = perRepo.flat().sort((left, right) => right.score - left.score);
      const shown = all
        .slice(0, limit ?? 8)
        .map((hit) => ({ repo: hit.repo, symbol: hit.symbol, kind: hit.kind, location: hit.location, sources: hit.sources }));
      return textResult({
        ...(all.length > shown.length
          ? {
              truncation: `showing ${shown.length} of ${all.length} matches; narrow the query, raise limit, or pass repo`,
            }
          : {}),
        results: shown,
      });
    },
  );

  return server;
}
