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

/** Contrato de tokens (patrón engram): previews cortos + get_evidence para el detalle. */
function preview(text: string): string {
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}… [preview]` : text;
}

function textResult(payload: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 1) }] };
}

function findSymbol(store: KnowledgeStore, snapshotId: string, name: string): CodeSymbol | null {
  const symbols = store.listSymbols(snapshotId);
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

export function createServer(store: KnowledgeStore): McpServer {
  const server = new McpServer({ name: 'repolead', version: '0.1.0' });
  const snapshot = store.getLatestSnapshot();
  if (!snapshot) {
    throw new Error('No hay snapshots en la base: corre `repolead scan` primero.');
  }
  const snapshotId = snapshot.id;
  const repository = store.getRepository(snapshot.repositoryId);
  const rootPath = repository?.rootPath ?? process.cwd();

  server.registerTool(
    'repo_overview',
    {
      description:
        'Visión técnica general del repositorio: stats del snapshot, módulos y el Repository Brief sintetizado por el Tech Lead. Úsala antes de explorar manualmente.',
      inputSchema: {},
    },
    () => {
      const counts = store.getCounts(snapshotId);
      const brief = store.db
        .prepare(
          "SELECT content_json FROM summaries WHERE snapshot_id = ? AND level = 'repository' ORDER BY created_at DESC LIMIT 1",
        )
        .get(snapshotId) as { content_json: string } | undefined;
      return textResult({
        repository: repository?.name,
        commit: snapshot.commitSha,
        stats: counts,
        modules: store.listModules(snapshotId).map((module) => module.name),
        brief: brief ? (JSON.parse(brief.content_json) as unknown) : 'sin analizar: corre `repolead analyze`',
      });
    },
  );

  server.registerTool(
    'module_context',
    {
      description:
        'Dossier de un módulo: responsabilidad, API pública, dependencias, riesgos y findings confirmados.',
      inputSchema: { module: z.string().describe('nombre del módulo (ver repo_overview)') },
    },
    ({ module: moduleName }) => {
      const module = store.listModules(snapshotId).find((entry) => entry.name === moduleName);
      if (!module) {
        return textResult({ error: `módulo desconocido: ${moduleName}` });
      }
      const dossier = store.db
        .prepare(
          "SELECT content_json FROM summaries WHERE snapshot_id = ? AND subject_id = ? AND level = 'module' ORDER BY created_at DESC LIMIT 1",
        )
        .get(snapshotId, module.id) as { content_json: string } | undefined;
      const findings = store
        .getFindings(snapshotId)
        .filter((finding) => finding.module === module.id && finding.status === 'confirmed');
      return textResult({
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

  server.registerTool(
    'symbol_context',
    {
      description: 'Ficha de un símbolo: ubicación, firma, relaciones entrantes y salientes.',
      inputSchema: { symbol: z.string().describe('qualified name, p. ej. PaymentService.process') },
    },
    ({ symbol: symbolName }) => {
      const symbol = findSymbol(store, snapshotId, symbolName);
      if (!symbol) {
        return textResult({ error: `símbolo desconocido: ${symbolName}` });
      }
      const graph = store.loadGraph(snapshotId);
      const describe = (id: string): string => graph.symbols.get(id)?.qualifiedName ?? id;
      return textResult({
        symbol: symbol.qualifiedName,
        kind: symbol.kind,
        signature: symbol.signature,
        location: `${symbol.path}:${symbol.startLine}-${symbol.endLine}`,
        incoming: (graph.incoming.get(symbol.id) ?? [])
          .slice(0, 20)
          .map((edge) => `${describe(edge.sourceId)} —${edge.edgeType}→ (${edge.analyzer})`),
        outgoing: (graph.outgoing.get(symbol.id) ?? [])
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
      },
    },
    ({ symbol: symbolName, transitiveDepth }) => {
      const symbol = findSymbol(store, snapshotId, symbolName);
      if (!symbol) {
        return textResult({ error: `símbolo desconocido: ${symbolName}` });
      }
      const graph = store.loadGraph(snapshotId);
      const depth = transitiveDepth ?? 1;
      const layers: string[][] = [];
      let frontier = new Set([symbol.id]);
      const seen = new Set(frontier);
      for (let level = 0; level < depth; level += 1) {
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
      return textResult({ symbol: symbol.qualifiedName, callersByDepth: layers });
    },
  );

  server.registerTool(
    'architecture_findings',
    {
      description: 'Findings arquitectónicos confirmados por el policy engine, filtrables.',
      inputSchema: {
        severity: z.array(z.string()).optional().describe('p. ej. ["high", "critical"]'),
        module: z.string().optional(),
      },
    },
    ({ severity, module: moduleName }) => {
      const module = moduleName
        ? store.listModules(snapshotId).find((entry) => entry.name === moduleName)
        : null;
      const findings = store
        .getFindings(snapshotId, 'confirmed')
        .filter((finding) => !severity || severity.includes(finding.severity))
        .filter((finding) => !module || finding.module === module.id);
      return textResult({
        findings: findings.map((finding) => ({
          findingId: finding.id,
          ruleId: finding.ruleId,
          severity: finding.severity,
          confidence: finding.confidence,
          claim: preview(finding.claim),
        })),
        hint: EVIDENCE_HINT,
      });
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
      },
    },
    ({ findingId, path, startLine, endLine }) => {
      const readRange = (filePath: string, start: number | null, end: number | null): string => {
        try {
          const lines = readFileSync(join(rootPath, filePath), 'utf8').split('\n');
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
        const evidence = store.getEvidence(findingId);
        if (evidence.length === 0) {
          return textResult({ error: `sin evidencia para ${findingId}` });
        }
        return textResult(
          evidence.map((item) => ({
            path: item.path,
            lines: item.startLine ? `${item.startLine}-${item.endLine ?? item.startLine}` : null,
            excerpt: item.excerpt,
            source: readRange(item.path, item.startLine, item.endLine),
          })),
        );
      }
      if (path) {
        return textResult({ path, source: readRange(path, startLine ?? null, endLine ?? null) });
      }
      return textResult({ error: 'pasa findingId o path' });
    },
  );

  server.registerTool(
    'search',
    {
      description:
        'Búsqueda híbrida de símbolos (FTS5 + vectores + grafo). Acepta lenguaje natural, también en español.',
      inputSchema: { query: z.string(), limit: z.number().int().min(1).max(20).optional() },
    },
    async ({ query, limit }) => {
      const tei = process.env['REPOLEAD_TEI_URL'] ?? 'http://localhost:8080';
      const qdrant = process.env['REPOLEAD_QDRANT_URL'] ?? 'http://localhost:6333';
      const reranker = process.env['REPOLEAD_RERANKER_URL'] ?? 'http://localhost:8081';
      const [teiUp, qdrantUp, rerankerUp] = await Promise.all([
        reachable(`${tei}/health`),
        reachable(`${qdrant}/healthz`),
        reachable(`${reranker}/health`),
      ]);
      const hits = await hybridSearch({
        store,
        snapshotId,
        collection: 'repolead-symbols',
        query,
        embeddings: teiUp ? new TeiEmbeddingsClient(tei) : null,
        qdrant: qdrantUp ? new QdrantRestClient(qdrant) : null,
        reranker: rerankerUp ? new TeiRerankerClient(reranker) : null,
        limit: limit ?? 8,
      });
      return textResult(
        hits.map((hit) => ({
          symbol: hit.symbol.qualifiedName,
          kind: hit.symbol.kind,
          location: `${hit.symbol.path}:${hit.symbol.startLine}-${hit.symbol.endLine}`,
          sources: hit.sources,
        })),
      );
    },
  );

  return server;
}
