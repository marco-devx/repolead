import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createProductServer } from './product';

import { impactAnalysis, traceFlow, listHotspots, improvementOpportunities, opportunityEvidence, mutationResults, dataFlowResults } from '@repolead/change-analysis';
import type { CodeSymbol } from '@repolead/domain';
import { KNOWLEDGE_KINDS, SUMMARY_LEVELS, DEFAULT_CONTEXT_TOKENS, MAX_CONTEXT_TOKENS, fileUri } from '@repolead/domain';
import type { KnowledgeStore } from '@repolead/knowledge-store';
import {
  hybridSearch,
  hybridKnowledgeSearch,
  buildContextPack,
  buildEvidenceContext,
  buildSourceRanges,
  countTokens,
  readIndexedSource,
  indexedCollection,
  retrievalServices,
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

function collectionFor(context: RepoContext): string {
  return indexedCollection(context.store, context.snapshotId);
}

/** Contrato de tokens (patrón engram): previews cortos + get_evidence para el detalle. */
function preview(text: string): string {
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}… [preview]` : text;
}

function textResult(payload: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

function findSymbolsIn(context: RepoContext, name: string): CodeSymbol[] {
  const symbols = context.store.listSymbols(context.snapshotId);
  for (const predicate of [
    (symbol: CodeSymbol) => symbol.id === name,
    (symbol: CodeSymbol) => symbol.qualifiedName === name,
    (symbol: CodeSymbol) => symbol.qualifiedName.endsWith(`.${name}`),
    (symbol: CodeSymbol) => symbol.qualifiedName.toLowerCase() === name.toLowerCase(),
  ]) {
    const matches = symbols.filter(predicate);
    if (matches.length) { return matches; }
  }
  return [];
}

/**
 * Servidor MCP sobre una o varias bases de RepoLead. Con varios repos, cada
 * tool acepta `repo`; cuando el objetivo es inequívoco (un solo repo, o el
 * símbolo/módulo existe en uno solo) se resuelve sin pedirlo.
 */
export interface ServerOptions {
  /** Functional projection only: no source, technical tools or raw resources. */
  product?: boolean;
  /** A smaller tool catalog for clients that only need retrieval, not diagnostics. */
  toolProfile?: 'all' | 'context';
  /** false = source restriction only, NOT a product security boundary (get_evidence
   * devuelve solo los metadatos y excerpts persistidos en la base). */
  exposeSource?: boolean;
}

export function createServer(repos: ServedRepo[], options: ServerOptions = {}): McpServer {
  if (options.toolProfile && !['all', 'context'].includes(options.toolProfile)) { throw new Error('Unknown MCP tool profile.'); }
  if (repos.some((repo) => !repo.name.trim()) || new Set(repos.map((repo) => repo.name)).size !== repos.length) {
    throw new Error('Served repository aliases must be nonempty and unique.');
  }
  if (options.product) { return createProductServer(repos); }
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

  const server = new McpServer({ name: 'repolead', version: '0.3.0' }, {
    instructions: 'Start questions with context_pack mode=evidence, repo and focused subquestions in queries (up to 8, default 120000 tokens). For product knowledge use types=[summary,document]: entrypoints mode generates analyses only for backend UseCase classes and frontend pages; other code remains indexed. Vector/lexical retrieval and reranking select relevant analyses. No global brief or synthesis is required in entrypoints mode; do not request regeneration. For implementation details use types=[symbol,summary] or get_evidence ranges to inspect dependencies and verify actual source. Use repo_overview for inventory and analysis status. knownBlocks=[] enables receipts; reuse only blocks still present in THIS conversation and fetch lost blocks again after compaction. Check warnings, omissions and uncertainty. Documentation is not proof of implementation; generated entrypoint analyses do not establish complete product coverage. All tools are read-only.',
  });

  const contextTools = new Set(['context_pack', 'repo_overview', 'search', 'get_evidence']);
  const registerTool: McpServer['registerTool'] = (name, config, handler) => {
    const tool = server.registerTool(name, config, handler);
    if (options.toolProfile === 'context' && !contextTools.has(name)) { tool.disable(); }
    return tool;
  };

  const repoParam = {
    repo: z.string().optional().describe(`repo objetivo (disponibles: ${repoNames})`),
  };

  type Resolved = RepoContext | { error: string } | null;
  const resolveRepo = (repo?: string): Resolved => {
    // Long-lived stdio clients must observe refresh without restarting their session.
    for (const context of contexts) {
      const latest = context.store.getLatestSnapshot();
      if (latest) {
        context.snapshotId = latest.id;
      }
    }
    if (repo) {
      return byName.get(repo) ?? { error: `repo desconocido: ${repo}. Disponibles: ${repoNames}` };
    }
    return single;
  };
  const isError = (value: Resolved): value is { error: string } =>
    value !== null && 'error' in value;

  const summaryUri = (repo: string, level: string, subjectId: string): string =>
    `repolead://knowledge/${encodeURIComponent(repo)}/${level}/${Buffer.from(subjectId).toString('base64url')}`;
  server.registerResource('repository-memory',
    new ResourceTemplate('repolead://knowledge/{repo}/{level}/{subject}', {
      list: () => {
        resolveRepo();
        return { resources: contexts.flatMap((context) => context.store.listVisibleSummaries(context.snapshotId).map((summary) => ({
          uri: summaryUri(context.name, summary.level, summary.subjectId),
          name: `${context.name}: ${summary.level} ${summary.subjectId}`,
          description: `Precomputed ${summary.level} analysis with evidence and uncertainty; snapshot ${context.snapshotId}`,
          mimeType: 'application/json',
        }))) };
      },
    }),
    { description: 'Read precomputed technical or product knowledge, including document sections and their evidence.', mimeType: 'application/json' },
    (uri, variables) => {
      const context = resolveRepo(decodeURIComponent(String(variables['repo'])));
      if (!context || isError(context)) { throw new Error('Unknown repository resource.'); }
      const level = SUMMARY_LEVELS.find((entry) => entry === variables['level']);
      if (!level) { throw new Error('Unknown summary level.'); }
      const encoded = String(variables['subject']);
      const subject = Buffer.from(encoded, 'base64url').toString('utf8');
      if (Buffer.from(subject).toString('base64url') !== encoded) { throw new Error('Invalid subject encoding.'); }
      const summary = context.store.getSummary(context.snapshotId, subject, level);
      if (!summary) { throw new Error('No analysis for this subject in the current snapshot; run analyze.'); }
      if (!context.store.isSummaryVisible(context.snapshotId, summary)) { throw new Error('Archived global or later-round summary; use context_pack to retrieve current file analyses and first-round syntheses.'); }
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({
        repo: context.name, snapshotId: context.snapshotId, subjectId: subject, level,
        model: summary.model, createdAt: summary.createdAt, summary: JSON.parse(summary.contentJson) as unknown,
        evidence: context.store.getSummaryEvidence(summary.id),
      }) }] };
    });

  registerTool(
    'context_pack',
    {
      description: 'Start with mode=evidence for questions: batch up to 8 short queries to search and return cited code excerpts, declarations and stored memory in ONE call (default 120000 tokens). Prefer several focused queries for a multi-part question. types=[symbol,summary] focuses implementation; tests excluded unless requested. mode=map keeps the compact navigation map (default 120000). No LLM call.',
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      inputSchema: {
        query: z.string().max(2000).optional(),
        mode: z.enum(['map', 'evidence']).optional(),
        queries: z.array(z.string().min(1).max(1000)).min(1).max(8).optional().describe('Evidence mode: distinct subquestions or code concepts, 4000 characters combined; do not combine with query/symbols.'),
        types: z.array(z.enum(KNOWLEDGE_KINDS)).min(1).max(5).optional().describe('Evidence mode knowledge kinds; default all. Source snippets are explicitly partial when a full symbol does not fit.'),
        includeTests: z.boolean().optional().describe('Evidence mode: include test code; default false.'),
        module: z.string().optional(),
        symbols: z.array(z.string()).max(20).optional().describe('exact qualified names or symbol IDs'),
        maxTokens: z.number().int().min(256).max(MAX_CONTEXT_TOKENS).optional().describe('global response budget; 120000 by default for map and evidence; o200k_base proxy'),
        includeSource: z.boolean().optional().describe('map: optional complete source (default false); evidence: source excerpts (default true), always subject to server restrictions'),
        knownBlocks: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(128).optional().describe('evidence only: [] enables SHA-256 block receipts. On follow-ups pass ONLY receipts whose full blocks remain in this conversation; unchanged blocks return references. Omit missing/compacted blocks to fetch their text again.'),
        ...repoParam,
      },
    },
    async ({ repo, query, queries, mode, types, includeTests, module, symbols, maxTokens, includeSource, knownBlocks }) => {
      const context = resolveRepo(repo);
      if (isError(context)) {
        return textResult(context);
      }
      if (!context) {
        return textResult({ error: 'pasa repo para construir un contexto con presupuesto global', repos: [...byName.keys()] });
      }
      try {
        if ((mode ?? (queries ? 'evidence' : 'map')) === 'evidence') {
          if ((query && queries) || symbols?.length) { throw new Error('Evidence mode accepts query or queries; use map mode for exact symbol selection.'); }
          let modulePath: string | undefined;
          if (module) {
            const matches = context.store.listModules(context.snapshotId).filter((entry) => entry.id === module || entry.path === module || entry.name === module);
            if (matches.length !== 1) { throw new Error('Unknown or ambiguous module; use its exact path.'); }
            modulePath = matches[0]!.path;
          }
          const services = await retrievalServices();
          const pack = await buildEvidenceContext({ store: context.store, snapshotId: context.snapshotId, collection: collectionFor(context),
            queries: queries ?? (query ? [query] : []), maxTokens, types, includeTests, filters: { module: modulePath },
            includeSource: exposeSource && (includeSource ?? true), knownBlocks, ...services });
          return { content: [{ type: 'text' as const, text: pack.text }] };
        }
        if (queries || types || includeTests !== undefined || knownBlocks !== undefined) { throw new Error('queries/types/includeTests/knownBlocks require evidence mode.'); }
        let seedIds: string[] | undefined;
        if (query && !symbols?.length && !module) {
          const services = await retrievalServices();
          const hits = await hybridSearch({
            store: context.store, snapshotId: context.snapshotId, collection: collectionFor(context), query, limit: 3,
            embeddings: services.embeddings,
            qdrant: services.qdrant,
          });
          seedIds = hits.map((hit) => hit.symbol.id);
        }
        const pack = buildContextPack({ store: context.store, snapshotId: context.snapshotId, query, module,
          symbols, seedIds, maxTokens, includeSource, exposeSource });
        return { content: [{ type: 'text' as const, text: pack.text }] };
      } catch (error) {
        return { ...textResult({ error: error instanceof Error ? error.message : String(error) }), isError: true };
      }
    },
  );

  registerTool(
    'repo_overview',
    {
      description:
        'Contexto precalculado técnico o de producto, con evidencia e incertidumbres. Sin `repo` y con varios repos servidos, lista todos.',
      inputSchema: { ...repoParam, audience: z.enum(['technical', 'product']).default('technical') },
    },
    ({ repo, audience }) => {
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
      const synthesisMode = resolved.store.getSnapshotMetadata(resolved.snapshotId, 'synthesis_mode');
      const firstRound = synthesisMode === 'first-round' || synthesisMode === 'entrypoints';
      const catalog = JSON.parse(resolved.store.getSnapshotMetadata(resolved.snapshotId, 'entrypoint_catalog') ?? '[]') as { kind: string }[];
      const visible = resolved.store.listVisibleSummaries(resolved.snapshotId);
      const brief = visible.filter((summary) => summary.level === (audience === 'product' ? 'product' : 'repository'))
        .find((summary) => !summary.subjectId.includes('#synthesis:'));
      return textResult({
        repository: resolved.name,
        snapshotId: resolved.snapshotId,
        audience,
        metricsStatus: JSON.parse(resolved.store.getSnapshotMetadata(resolved.snapshotId, 'metrics_status') ?? '{"status":"unknown"}') as unknown,
        stats: resolved.store.getCounts(resolved.snapshotId),
        modules: resolved.store.listModules(resolved.snapshotId).map((module) => module.name),
        documents: audience === 'product' ? resolved.store.listDocuments(resolved.snapshotId).map((document) => ({ path: document.path, title: document.title })) : undefined,
        resource: brief ? summaryUri(resolved.name, brief.level, brief.subjectId) : null,
        brief: brief ? (JSON.parse(brief.contentJson) as unknown) : firstRound
          ? 'Resumen global omitido por diseño. Recupera los análisis pertinentes con context_pack mode=evidence.' : 'sin analizar: corre `repolead analyze`',
        ...(firstRound ? { synthesisMode,
          analysisStatus: JSON.parse(resolved.store.getSnapshotMetadata(resolved.snapshotId, 'technical_analysis') ?? '{}') as unknown,
          productStatus: JSON.parse(resolved.store.getSnapshotMetadata(resolved.snapshotId, 'product_analysis') ?? '{}') as unknown,
          availableMemory: { fileAnalyses: visible.filter((summary) => summary.level === 'file').length,
            moduleSyntheses: visible.filter((summary) => summary.level === 'module').length,
            documentAnalyses: visible.filter((summary) => summary.level === 'document').length,
            usecases: catalog.filter((target) => target.kind === 'usecase').length,
            pages: catalog.filter((target) => target.kind === 'page').length } } : {}),
      });
    },
  );

  registerTool(
    'module_context',
    {
      description: 'Dossier de un módulo: responsabilidad, API, riesgos y findings confirmados.',
      inputSchema: { module: z.string(), ...repoParam },
    },
    ({ module: moduleName, repo }) => {
      const resolved = resolveRepo(repo);
      if (isError(resolved)) {
        return textResult(resolved);
      }
      const matches = (resolved ? [resolved] : contexts).flatMap((context) => {
        const modules = context.store.listModules(context.snapshotId);
        const exact = modules.filter((module) => module.id === moduleName || module.path === moduleName);
        return (exact.length ? exact : modules.filter((module) => module.name === moduleName)).map((module) => ({ context, module }));
      });
      if (matches.length !== 1) { return textResult({ error: matches.length ? `módulo ambiguo: ${matches.map(({ context, module }) => `${context.name} ${module.path} (${module.id})`).join(', ')}; usa ID/ruta y repo.` : `módulo desconocido: ${moduleName}` }); }
      const { context, module } = matches[0]!;
      const synthesisMode = context.store.getSnapshotMetadata(context.snapshotId, 'synthesis_mode');
      const firstRound = synthesisMode === 'first-round' || synthesisMode === 'entrypoints';
      const dossier = firstRound ? null : context.store.getSummary(context.snapshotId, module.id, 'module');
      const groups = firstRound ? context.store.listVisibleSummaries(context.snapshotId, 'module')
        .filter((summary) => summary.subjectId.startsWith(`${module.id}#synthesis:0:`)) : [];
      const findings = context.store
        .getFindings(context.snapshotId, 'confirmed')
        .filter((finding) => finding.module === module.id);
      return textResult({
        repo: context.name,
        module: module.name,
        path: module.path,
        quality: context.store.qualityFacts(context.snapshotId, module.id),
        dossier: dossier ? (JSON.parse(dossier.contentJson) as unknown) : firstRound
          ? 'Sin dossier global por diseño; recupera los análisis pertinentes con context_pack mode=evidence, types=[summary], module=<ruta>.' : 'sin analizar',
        ...(firstRound ? { synthesisMode, firstRoundGroups: groups.length } : {}),
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
    const matches = (resolved ? [resolved] : contexts)
      .flatMap((context) => findSymbolsIn(context, symbolName).map((symbol) => ({ context, symbol })));
    if (matches.length === 1) {
      return matches[0]!;
    }
    return {
      error:
        matches.length === 0
          ? `símbolo desconocido${resolved ? ` en ${resolved.name}` : ' en todos los repos'}: ${symbolName}`
          : `símbolo ambiguo: ${matches.map((match) => `${match.context.name} ${match.symbol.path}: ${match.symbol.id}`).join(', ')}. Usa su ID exacto y, si hace falta, repo.`,
    };
  };

  registerTool(
    'symbol_context',
    {
      description: 'Ficha de un símbolo por ID o nombre inequívoco: ubicación, firma, métricas y relaciones.',
      inputSchema: { symbol: z.string(), ...repoParam },
    },
    ({ symbol: symbolName, repo }) => {
      const located = locateSymbol(symbolName, repo);
      if ('error' in located) {
        return textResult(located);
      }
      const { context, symbol } = located;
      const graph = context.store.loadGraph(context.snapshotId);
      const candidateCard = context.store.getSummary(context.snapshotId, symbol.id, 'symbol');
      const card = candidateCard && context.store.isSummaryVisible(context.snapshotId, candidateCard) ? candidateCard : null;
      const repository = context.store.getRepository(context.store.getSnapshot(context.snapshotId)!.repositoryId)!;
      const candidateFile = !card ? context.store.getSummary(context.snapshotId, fileUri(repository.name, symbol.path), 'file') : null;
      const fileDossier = candidateFile && context.store.isSummaryVisible(context.snapshotId, candidateFile) ? candidateFile : null;
      const catalog = JSON.parse(context.store.getSnapshotMetadata(context.snapshotId, 'entrypoint_catalog') ?? '[]') as {
        path: string; startLine: number; endLine: number; summarySubjectId: string;
      }[];
      const subjects = new Set(catalog.filter((entry) => entry.path === symbol.path && symbol.startLine >= entry.startLine
        && symbol.endLine <= entry.endLine).map((entry) => entry.summarySubjectId));
      const fileSections = !card && !fileDossier ? context.store.listVisibleSummaries(context.snapshotId, 'file')
        .filter((summary) => subjects.has(summary.subjectId) || summary.subjectId.startsWith(`${fileUri(repository.name, symbol.path)}#`)) : [];
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
        visibility: symbol.visibility ?? 'unknown',
        ...(symbol.span ? { span: symbol.span } : {}),
        ...(symbol.route ? { route: symbol.route } : {}),
        exports: context.store.listExports(context.snapshotId).filter((entry) => entry.symbolId === symbol.id),
        location: `${symbol.path}:${symbol.startLine}-${symbol.endLine}`,
        quality: context.store.qualityFacts(context.snapshotId, symbol.id, symbol.path, symbol),
        card: card ? JSON.parse(card.contentJson) as unknown : fileDossier
          ? 'Covered by the complete file dossier; no individual symbol generation was required.' : fileSections.length
            ? 'Covered by indexed entrypoint analyses or file sections; use context_pack mode=evidence to retrieve relevant claims.'
            : context.store.getSnapshotMetadata(context.snapshotId, 'synthesis_mode') === 'entrypoints'
              ? 'Indexed as source only; generated analyses are limited to usecases/pages. Use get_evidence for implementation.' : 'sin analizar: corre repolead analyze',
        ...(fileDossier ? { fileDossier: JSON.parse(fileDossier.contentJson) as unknown } : {}),
        ...(fileSections.length ? { fileResources: fileSections.map((summary) => summaryUri(context.name, summary.level, summary.subjectId)) } : {}),
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

  registerTool(
    'find_references',
    {
      description: 'Referencias resueltas por SCIP con ubicaciones exactas, incluidas referencias fuera de funciones. Distingue una llamada sintáctica de una referencia; no es una traza de ejecución.',
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      inputSchema: { symbol: z.string(), includeDefinitions: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).optional(), offset: z.number().int().min(0).optional(), ...repoParam },
    },
    ({ symbol: name, repo, includeDefinitions, limit, offset }) => {
      const located = locateSymbol(name, repo);
      if ('error' in located) { return textResult(located); }
      const { context, symbol } = located;
      const complete = context.store.getReferences(context.snapshotId, symbol.id, true);
      const references = includeDefinitions ? complete : complete.filter((entry) => !entry.isDefinition);
      const start = offset ?? 0;
      const selected = references.slice(start, start + (limit ?? 50));
      return textResult({ repo: context.name, snapshotId: context.snapshotId, symbol: symbol.qualifiedName,
        columns: 'zero-based UTF-16; end exclusive', lines: 'one-based', total: references.length,
        definitionMapped: complete.some((entry) => entry.isDefinition),
        ...(!complete.some((entry) => entry.isDefinition) ? { unknowns: ['No SCIP definition mapped for this symbol; an empty result does not prove there are no references.'] } : {}),
        references: selected.map(({ snapshotId: _snapshotId, scipSymbol: _scipSymbol, ...entry }) => entry),
        nextOffset: start + selected.length < references.length ? start + selected.length : null,
        indexers: JSON.parse(context.store.getSnapshotMetadata(context.snapshotId, 'scip_diagnostics') ?? '{"indexers":[]}').indexers as unknown,
      });
    },
  );

  registerTool(
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

  const traversalSchema = {
    maxDepth: z.number().int().min(0).max(32).optional().describe('default 12; static graph hops'),
    maxNodes: z.number().int().min(1).max(5000).optional().describe('default 500'),
    maxEdges: z.number().int().min(1).max(20000).optional().describe('default 2000'),
  };
  registerTool('trace_flow', {
    description: 'Static paths with stored evidence. engine=graph (default) follows calls/effects; engine=joern reads a previously computed parameter-to-call-argument data flow, with from=exact method name, to=exact call name. Neither proves runtime execution. Never executes Joern.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: { engine: z.enum(['graph', 'joern']).optional(), language: z.enum(['javascript', 'python']).optional(), from: z.string(), to: z.string().optional(), maxPaths: z.number().int().min(1).max(100).optional(), ...traversalSchema, ...repoParam },
  }, ({ repo, ...input }) => {
    let context = resolveRepo(repo);
    if (isError(context)) { return textResult(context); }
    if (input.engine === 'joern') {
      if (input.maxDepth !== undefined || input.maxNodes !== undefined || input.maxEdges !== undefined) {
        return textResult({ error: 'Graph depth/node/edge bounds do not apply to stored Joern results; use maxPaths to bound this response.' });
      }
      if (!context || !input.to) { return textResult({ error: 'Joern flow requires an explicit repository in multi-repo mode and a sink call in to.' }); }
      return textResult({ repo: context.name, ...dataFlowResults(context.store, context.snapshotId,
        { sourceMethod: input.from, sinkCall: input.to, language: input.language }, input.maxPaths) });
    }
    if (!context) {
      const found = locateSymbol(input.from);
      if ('error' in found) { return textResult(found); }
      context = found.context;
    }
    return textResult({ repo: context.name, ...traceFlow(context.store, context.snapshotId, input) });
  });
  registerTool('impact_analysis', {
    description: 'Potential affected symbols/files/modules, public contracts, tests, recorded effects and risks for a proposed change. Versioned 0–100 score with unknown-factor range and provisional workflow. Use exact symbols/paths, or a change naming an indexed identifier; specify repo in multi-repo mode.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: { change: z.string().max(8000).optional(), symbols: z.array(z.string()).max(100).optional(), paths: z.array(z.string()).max(100).optional(),
      facts: z.object({ publicApiChange: z.boolean().optional(), schemaChange: z.boolean().optional(), contractChange: z.boolean().optional(),
        authorizationChange: z.boolean().optional(), concurrencyChange: z.boolean().optional(), externalEffects: z.boolean().optional(),
        persistenceChange: z.boolean().optional(), reversible: z.boolean().optional() }).strict().optional()
        .describe('Optional caller-provided change facts; never treated as independently verified.'),
      offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(200).optional().describe('default 20; independently paginates every detail category'),
      ...traversalSchema, ...repoParam },
  }, ({ repo, ...input }) => {
    const context = resolveRepo(repo);
    if (isError(context)) { return textResult(context); }
    if (!context) { return textResult({ error: `pasa repo para analizar el impacto (disponibles: ${repoNames})` }); }
    return textResult({ repo: context.name, ...impactAnalysis(context.store, context.snapshotId, input) });
  });

  registerTool('mutation_results', {
    description: 'Read the latest or selected source-bound mutation report in the current snapshot. Paginated mutant statuses, score basis and freshness limits. Never runs tests or Stryker.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: { reportId: z.string().optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(200).optional(), ...repoParam },
  }, ({ repo, ...input }) => {
    const context = resolveRepo(repo);
    if (isError(context)) { return textResult(context); }
    if (!context) { return textResult({ error: `Specify repo for mutation results (available: ${repoNames}).` }); }
    return textResult({ repo: context.name, ...mutationResults(context.store, context.snapshotId, input) });
  });

  const prioritySchema = {
    module: z.string().optional().describe('Exact owning module name, path or ID; ambiguous names require an ID.'),
    offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(200).optional().describe('default 10'),
    ...repoParam,
  };
  for (const name of ['hotspots', 'improvement_opportunities'] as const) {
    registerTool(name, {
      description: name === 'hotspots'
        ? 'Rank callable hotspots using measured complexity, observed fan-in, bounded Git history and verified coverage. Explicit uncertainty range; missing coverage is unknown. No model or test execution.'
        : 'Read persisted opportunities derived from confirmed findings and hotspots, with priority and evidence. Stale projections are withheld; scan/metrics/audit or repolead opportunities regenerate them. No model calls.',
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, inputSchema: prioritySchema,
    }, ({ repo, ...input }) => {
      const context = resolveRepo(repo);
      if (isError(context)) { return textResult(context); }
      if (!context) { return textResult({ error: `Specify repo for prioritization (available: ${repoNames}).` }); }
      if (name === 'hotspots') { return textResult({ repo: context.name, ...listHotspots(context.store, context.snapshotId, input) }); }
      const report = improvementOpportunities(context.store, context.snapshotId, input);
      return textResult({ repo: context.name, ...report, items: report.items.map((item) => ({ ...item, title: preview(item.title), description: preview(item.description) })) });
    });
  }

  registerTool(
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

  registerTool(
    'get_evidence',
    {
      description:
        'Read evidence or current source. Prefer ranges to read up to 20 files/spans together under one maxTokens budget (default 120000); omitted lines have continuation coordinates. Single path also reads to EOF unless endLine is supplied. Also accepts documentId, evidenceId, findingId or opportunityId.',
      inputSchema: {
        findingId: z.string().optional(),
        opportunityId: z.string().optional().describe('Current derived opportunity ID; stale/historical opportunities are refused.'),
        documentId: z.string().optional().describe('document subjectId returned by search; reads the current SQLite snapshot'),
        evidenceId: z.string().optional().describe('evidence ID cited by a summary; returns provenance metadata and parent references'),
        path: z.string().optional(),
        startLine: z.number().int().min(1).optional(),
        endLine: z.number().int().min(1).optional(),
        ranges: z.array(z.object({ path: z.string().min(1).max(2048), startLine: z.number().int().min(1).optional(), endLine: z.number().int().min(1).optional() })).min(1).max(20).optional().describe('Batch source reads; omitted endLine reads to EOF. Do not combine with other selectors.'),
        maxTokens: z.number().int().min(256).max(MAX_CONTEXT_TOKENS).optional().describe('Global source budget for ranges/path; o200k_base proxy.'),
        ...repoParam,
      },
    },
    ({ findingId, opportunityId, evidenceId, documentId, path, startLine, endLine, ranges, maxTokens, repo }) => {
      const target = resolveRepo(repo);
      if (isError(target)) { return textResult(target); }
      if (ranges && [findingId, opportunityId, evidenceId, documentId, path, startLine, endLine].some((value) => value !== undefined)) {
        return { ...textResult({ error: 'ranges cannot be combined with other evidence selectors or top-level lines.' }), isError: true };
      }
      if (ranges || path) {
        if (!exposeSource) { return textResult({ error: 'source access disabled on this server' }); }
        if (!target) { return textResult({ error: 'Specify repo for source ranges.' }); }
        try {
          const pack = buildSourceRanges({ snapshotId: target.snapshotId,
            ranges: ranges ?? [{ path: path!, startLine, endLine }], maxTokens,
            read: (filePath) => readIndexedSource(target.store, target.snapshotId, target.rootPath, filePath) });
          return ranges ? { content: [{ type: 'text' as const, text: pack.text }] }
            : textResult({ repo: target.name, path, source: pack.text });
        } catch (error) { return { ...textResult({ error: error instanceof Error ? error.message : String(error) }), isError: true }; }
      }
      if (startLine && endLine && endLine < startLine) { return textResult({ error: 'endLine must be at least startLine' }); }
      const excerpt = (content: string, start: number | null, end: number | null): string => {
        const lines = content.split('\n');
        const from = Math.max((start ?? 1) - 1, 0);
        const requestedEnd = Math.min(end ?? lines.length, lines.length);
        let to = requestedEnd;
        const render = (): string => lines.slice(from, to).map((line, index) => `${from + index + 1}\t${line}`).join('\n') +
          (to < requestedEnd ? `\n[truncated; request startLine=${to + 1}]` : '');
        const budget = maxTokens ?? DEFAULT_CONTEXT_TOKENS;
        let low = from; let high = to;
        while (low < high) {
          to = Math.ceil((low + high) / 2);
          if (countTokens(render()) <= budget) { low = to; } else { high = to - 1; }
        }
        to = low;
        while (to > from && countTokens(render()) > budget) { to -= 1; }
        if (to === from && from < requestedEnd) { return `[Line ${from + 1} exceeds the ${budget}-token range limit; use a stored summary or read the document outside this tool.]`; }
        return render();
      };
      if (documentId) {
        const matches = (target ? [target] : contexts).flatMap((context) => context.store.listDocuments(context.snapshotId)
          .filter((document) => document.id === documentId).map((document) => ({ context, document })));
        if (matches.length !== 1) { return textResult({ error: 'Document unknown or ambiguous in the current snapshot; specify repo.' }); }
        const { context, document } = matches[0]!;
        return textResult({ repo: context.name, snapshotId: context.snapshotId, documentId, path: document.path,
          contentHash: document.contentHash, source: 'indexed_document', text: excerpt(document.content, startLine ?? null, endLine ?? null) });
      }
      if (evidenceId) {
        const owners = (target ? [target] : contexts).filter((context) => context.store.getEvidenceRecord(evidenceId));
        if (owners.length !== 1) { return textResult({ error: 'Evidence unknown or ambiguous; specify repo.' }); }
        const record = owners[0]!.store.getEvidenceRecord(evidenceId)!;
        return textResult({ repo: owners[0]!.name, evidence: record,
          parents: record.parentIds.map((id) => owners[0]!.store.getEvidenceRecord(id)),
          hint: 'Provenance metadata, not a new source read. Use path and lines to request current indexed source.' });
      }
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
          return excerpt(readIndexedSource(context.store, context.snapshotId, context.rootPath, filePath), start, end);
        } catch (error) {
          return `(source unavailable: ${error instanceof Error ? error.message : String(error)})`;
        }
      };
      if (opportunityId) {
        const matches = (target ? [target] : contexts).flatMap((context) => {
          const found = opportunityEvidence(context.store, context.snapshotId, opportunityId);
          return found ? [{ context, ...found }] : [];
        });
        if (matches.length !== 1) { return textResult({ error: 'Opportunity unavailable, stale or ambiguous; regenerate opportunities or specify repo.' }); }
        const { context, opportunity, evidence } = matches[0]!;
        return textResult({ repo: context.name, snapshotId: context.snapshotId, opportunity,
          evidence: evidence.map((item) => ({ ...item, source: item.startLine === null && context.store.listModules(context.snapshotId).some((module) => module.path === item.path)
            ? '(module-level evidence; inspect sourceKind/sourceId and module_context)' : readRange(context, item.path, item.startLine, item.endLine) })) });
      }
      if (findingId) {
        const owners = (target ? [target] : contexts).filter((context) => context.store.getFindings(context.snapshotId).some((finding) => finding.id === findingId));
        if (owners.length > 1) { return textResult({ error: 'Finding ambiguous; specify repo.' }); }
        for (const context of owners) {
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
      return textResult({ error: 'pasa evidenceId, documentId, findingId, opportunityId o path' });
    },
  );

  registerTool(
    'search',
    {
      description:
        'Búsqueda de código, resúmenes, documentos, hallazgos y tests (FTS5 + vectores + grafo), también en español. Devuelve identificadores y ubicaciones; usa resources/get_evidence para profundizar. Sin `repo`, busca en todos los repos.',
      inputSchema: {
        query: z.string(),
        limit: z.number().int().min(1).max(20).optional(),
        type: z.enum(KNOWLEDGE_KINDS).optional(),
        language: z.string().optional(),
        module: z.string().optional(),
        kind: z.string().optional(),
        ...repoParam,
      },
    },
    async ({ query, limit, repo, type, language, module, kind }) => {
      const resolved = resolveRepo(repo);
      if (isError(resolved)) {
        return textResult(resolved);
      }
      const targets = resolved ? [resolved] : contexts;
      const services = await retrievalServices();
      const warnings: string[] = [];
      if (!services.embeddings || !services.qdrant) { warnings.push('Vector services unavailable; using lexical search and graph.'); }
      if (!services.reranker) { warnings.push('Reranker unavailable; using fused ranking.'); }
      const perRepo = await Promise.all(
        targets.map(async (context) => {
          const hits = await hybridKnowledgeSearch({
            store: context.store,
            snapshotId: context.snapshotId,
            collection: collectionFor(context),
            query,
            ...services,
            limit: limit ?? 8,
            filters: { entityKinds: type ? [type] : undefined, language, module, kind },
            onWarning: (message) => warnings.push(`${context.name}: ${message}`),
          });
          return hits.map((hit) => ({
            repo: context.name,
            snapshotId: context.snapshotId,
            id: hit.item.id,
            subjectId: hit.item.subjectId,
            title: hit.item.title,
            ...(hit.item.entityKind === 'symbol' ? { symbol: hit.item.title } : {}),
            type: hit.item.entityKind,
            kind: hit.item.kind,
            location: `${hit.item.path}${hit.item.startLine ? `:${hit.item.startLine}-${hit.item.endLine}` : ''}`,
            sourceComplete: hit.item.sourceComplete,
            evidenceIds: hit.item.evidenceIds,
            ...(hit.item.entityKind === 'document' ? { documentId: hit.item.subjectId } : {}),
            ...(hit.item.entityKind === 'finding' ? { findingId: hit.item.subjectId } : {}),
            ...(hit.item.entityKind === 'summary' ? { resource: summaryUri(context.name, hit.item.kind, hit.item.subjectId) } : {}),
            score: hit.score,
            sources: hit.sources,
          }));
        }),
      );
      const all = perRepo.flat().sort((left, right) => right.score - left.score);
      const shown = all
        .slice(0, limit ?? 8)
        .map(({ score: _score, ...hit }) => hit);
      return textResult({
        ...(warnings.length ? { warnings: [...new Set(warnings)] } : {}),
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
