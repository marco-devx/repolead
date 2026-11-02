import type { Severity } from '@repolead/domain';
import { fileUri } from '@repolead/domain';
import type { KnowledgeStore } from '@repolead/knowledge-store';
import { lowCohesion, metricThreshold, toolIssue } from './quality-detectors';
import { directedCycles } from './cycles';

export interface CandidateEvidence {
  path: string;
  startLine: number | null;
  endLine: number | null;
  excerpt: string | null;
  kind?: 'dependency_path' | 'metric' | 'test_links' | 'source_excerpt';
}

export interface Candidate {
  claim: string;
  module: string | null;
  evidence: CandidateEvidence[];
  facts?: Record<string, unknown>;
}

export type Detector = (
  store: KnowledgeStore,
  snapshotId: string,
  params: Record<string, unknown>,
) => Candidate[];

interface EdgeRow {
  source_id: string;
  target_id: string;
  edge_type: string;
  evidence_json: string;
}

function pathsForSnapshot(store: KnowledgeStore, snapshotId: string): (uri: string) => string {
  const snapshot = store.getSnapshot(snapshotId);
  const repository = snapshot ? store.getRepository(snapshot.repositoryId) : null;
  const prefix = repository ? fileUri(repository.name, '') : null;
  return (uri) => prefix && uri.startsWith(prefix) ? uri.slice(prefix.length) : uri;
}

/** module path de cada archivo según los edges CONTAINS de module-detection. */
function fileToModule(store: KnowledgeStore, snapshotId: string): Map<string, string> {
  const pathOfFileUri = pathsForSnapshot(store, snapshotId);
  const rows = store.db
    .prepare(
      `SELECT source_id, target_id FROM edges
       WHERE snapshot_id = ? AND edge_type = 'CONTAINS' AND analyzer = 'module-detection'`,
    )
    .all(snapshotId) as { source_id: string; target_id: string }[];
  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(pathOfFileUri(row.target_id), row.source_id);
  }
  return map;
}

/** Closed import paths of any length; every hop is backed by a stored edge. */
const moduleCycle: Detector = (store, snapshotId) => {
  const pathOfFileUri = pathsForSnapshot(store, snapshotId);
  const moduleOf = fileToModule(store, snapshotId);
  const imports = store.db
    .prepare(
      `SELECT source_id, target_id, edge_type, evidence_json FROM edges
       WHERE snapshot_id = ? AND edge_type = 'IMPORTS'`,
    )
    .all(snapshotId) as EdgeRow[];

  const crossModule = new Map<string, EdgeRow>();
  for (const edge of imports) {
    const from = moduleOf.get(pathOfFileUri(edge.source_id));
    const to = moduleOf.get(pathOfFileUri(edge.target_id));
    if (from && to && from !== to && !crossModule.has(`${from}\n${to}`)) {
      crossModule.set(`${from}\n${to}`, edge);
    }
  }

  const adjacency = new Map<string, Set<string>>();
  for (const key of crossModule.keys()) {
    const [from, to] = key.split('\n') as [string, string];
    const targets = adjacency.get(from) ?? new Set<string>(); targets.add(to); adjacency.set(from, targets);
  }
  return directedCycles(adjacency).map((path) => ({
      claim: `Ciclo de dependencia entre módulos: ${path.join(' → ')}`,
      module: path[0]!,
      facts: { cycle: path, scope: 'detected DFS cycle witnesses; not enumeration of every simple cycle' },
      evidence: path.slice(0, -1).map((from, index) => {
        const edge = crossModule.get(`${from}\n${path[index + 1]}`)!;
        const meta = JSON.parse(edge.evidence_json) as { path?: string; line?: number };
        return {
          path: meta.path ?? pathOfFileUri(edge.source_id),
          startLine: meta.line ?? null,
          endLine: meta.line ?? null,
          excerpt: `${pathOfFileUri(edge.source_id)} → ${pathOfFileUri(edge.target_id)}${meta.line ? `\n${store.getSnapshotSource(snapshotId, meta.path ?? pathOfFileUri(edge.source_id))?.split('\n')[meta.line - 1] ?? ''}` : ''}`,
          kind: 'dependency_path' as const,
        };
      }),
    }));
};

/** Símbolos con fan-in por encima del umbral (candidatos a god symbol). */
const highFanIn: Detector = (store, snapshotId, params) => {
  const threshold = typeof params['threshold'] === 'number' ? params['threshold'] : 20;
  const rows = store.db
    .prepare(
      `SELECT s.qualified_name, s.path, s.start_line, s.end_line, COUNT(DISTINCT e.source_id) AS fan_in
       FROM edges e JOIN symbols s ON s.id = e.target_id AND s.snapshot_id = e.snapshot_id
       WHERE e.snapshot_id = ? AND e.edge_type IN ('CALLS', 'DEPENDS_ON') AND e.source_id != e.target_id
       GROUP BY e.target_id HAVING fan_in >= ? ORDER BY fan_in DESC`,
    )
    .all(snapshotId, threshold) as {
    qualified_name: string;
    path: string;
    start_line: number;
    end_line: number;
    fan_in: number;
  }[];
  return rows.map((row) => ({
    claim: `${row.qualified_name} tiene fan-in ${row.fan_in} (umbral ${threshold}): posible god symbol o abstracción faltante`,
    module: null,
    evidence: [
      { path: row.path, startLine: row.start_line, endLine: row.end_line, excerpt: `${row.qualified_name}: fan_in=${row.fan_in}`, kind: 'metric' as const },
    ],
  }));
};

/** Módulos con símbolos suficientes pero sin ningún edge TESTED_BY. */
const untestedModule: Detector = (store, snapshotId, params) => {
  const pathOfFileUri = pathsForSnapshot(store, snapshotId);
  const minSymbols = typeof params['minSymbols'] === 'number' ? params['minSymbols'] : 5;
  const moduleOf = fileToModule(store, snapshotId);

  const testedFiles = new Set(
    (
      store.db
        .prepare(
          `SELECT source_id FROM edges WHERE snapshot_id = ? AND edge_type = 'TESTED_BY'`,
        )
        .all(snapshotId) as { source_id: string }[]
    ).map((row) => pathOfFileUri(row.source_id)),
  );

  const symbolCount = new Map<string, number>();
  const testedModules = new Set<string>();
  for (const symbol of store.listSymbols(snapshotId)) {
    const module = moduleOf.get(symbol.path);
    if (!module) {
      continue;
    }
    symbolCount.set(module, (symbolCount.get(module) ?? 0) + 1);
    if (testedFiles.has(symbol.path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(symbol.path) || /(^|\/)(test_[^/]+\.py|[^/]+_test\.py)$/.test(symbol.path)) {
      testedModules.add(module);
    }
  }

  const modules = store.listModules(snapshotId);
  return modules
    .filter(
      (module) =>
        (symbolCount.get(module.id) ?? 0) >= minSymbols && !testedModules.has(module.id),
    )
    .map((module) => ({
      claim: `El módulo ${module.name} tiene ${symbolCount.get(module.id)} símbolos y ningún test vinculado`,
      module: module.id,
      evidence: [
        { path: module.path, startLine: null, endLine: null, excerpt: `module ${module.name}: no linked tests`, kind: 'test_links' as const },
      ],
    }));
};

/** Imports prohibidos por patrón: from (path del archivo) → to (path destino o specifier). */
const forbiddenImport: Detector = (store, snapshotId, params) => {
  const pathOfFileUri = pathsForSnapshot(store, snapshotId);
  const fromPattern = typeof params['from'] === 'string' ? new RegExp(params['from']) : null;
  const toPattern = typeof params['to'] === 'string' ? new RegExp(params['to']) : null;
  if (!fromPattern || !toPattern) {
    return [];
  }
  const imports = store.db
    .prepare(
      `SELECT source_id, target_id, edge_type, evidence_json FROM edges
       WHERE snapshot_id = ? AND edge_type = 'IMPORTS'`,
    )
    .all(snapshotId) as EdgeRow[];

  return imports
    .map((edge) => ({ edge, meta: JSON.parse(edge.evidence_json) as { path?: string; line?: number; specifier?: string } }))
    .filter(({ edge, meta }) => {
      const sourcePath = meta.path ?? pathOfFileUri(edge.source_id);
      const target = meta.specifier ?? pathOfFileUri(edge.target_id);
      return fromPattern.test(sourcePath) && (toPattern.test(target) || toPattern.test(pathOfFileUri(edge.target_id)));
    })
    .map(({ edge, meta }) => ({
      claim: `${meta.path ?? pathOfFileUri(edge.source_id)} importa ${meta.specifier ?? pathOfFileUri(edge.target_id)} (patrón prohibido por la policy)`,
      module: null,
      evidence: [
        {
          path: meta.path ?? pathOfFileUri(edge.source_id),
          startLine: meta.line ?? null,
          endLine: meta.line ?? null,
          excerpt: meta.specifier ?? null,
          kind: 'dependency_path' as const,
        },
        ...((): CandidateEvidence[] => {
          const path = meta.path ?? pathOfFileUri(edge.source_id);
          const source = store.getSnapshotSource(snapshotId, path);
          if (source === null) { return []; }
          const lines = source.split('\n');
          return [{ path, startLine: 1, endLine: Math.min(80, lines.length), kind: 'source_excerpt',
            excerpt: lines.slice(0, 80).join('\n') + (lines.length > 80 ? '\n[remaining source omitted]' : '') }];
        })(),
      ],
    }));
};

const frameworkTypeLeak: Detector = (store, snapshotId, params) => {
  const from = new RegExp(typeof params['from'] === 'string' ? params['from'] : '(^|/)(domain|core|entities|use-cases)/');
  const framework = new RegExp(typeof params['framework'] === 'string' ? params['framework'] : '^(express|@nestjs/(common|core)|fastify|koa|fastapi|starlette|django)([./]|$)');
  const modules = fileToModule(store, snapshotId);
  const graph = store.loadGraph(snapshotId);
  return [...graph.outgoing.values()].flat().filter((edge) => edge.analyzer === 'tree-sitter-type-contract' && edge.edgeType === 'DEPENDS_ON')
    .flatMap((edge) => {
      const symbol = graph.symbols.get(edge.sourceId);
      const data = edge.evidence as { path: string; specifier: string; imported: string; importLine: number; usage: string;
        locations: { startLine: number; endLine: number; expression: string }[] };
      if (!symbol || !from.test(symbol.path) || !framework.test(data.specifier) || data.usage !== 'public_signature') { return []; }
      const source = store.getSnapshotSource(snapshotId, symbol.path);
      if (source === null) { return []; }
      const lines = source.split('\n');
      return [{ claim: `${symbol.qualifiedName} expone ${data.imported} de ${data.specifier} en su contrato público`, module: modules.get(symbol.path) ?? null,
        facts: { source_symbol: symbol.id, importedType: data.imported, framework: data.specifier, usage: data.usage },
        evidence: [{ path: symbol.path, startLine: data.importLine, endLine: data.importLine, kind: 'dependency_path' as const,
          excerpt: lines[data.importLine - 1] ?? `${symbol.path} → ${data.specifier}` },
        ...data.locations.map((location) => ({ path: symbol.path, startLine: location.startLine, endLine: location.endLine,
          kind: 'source_excerpt' as const, excerpt: lines.slice(location.startLine - 1, location.endLine).join('\n') }))] }];
    });
};

export const DETECTORS: Record<string, Detector> = {
  module_cycle: moduleCycle,
  high_fan_in: highFanIn,
  untested_module: untestedModule,
  forbidden_import: forbiddenImport,
  graph_dependency_direction: (store, snapshotId, params) => forbiddenImport(store, snapshotId, {
    from: '(^|/)(domain|core)/',
    to: '(^|/)(infrastructure|infra|adapters|prisma|typeorm|sequelize|knex|mongoose|pg|mysql2|axios|node-fetch)(/|$)|^@prisma/client$', ...params,
  }),
  persistence_import_in_domain: (store, snapshotId, params) => forbiddenImport(store, snapshotId, {
    from: '(^|/)(domain|entities|use-cases)/',
    to: '(^|/)(typeorm|sequelize|mongoose|prisma|@prisma/client|drizzle-orm|sqlalchemy|peewee|django\\.db)(/|$)', ...params,
  }),
  framework_type_leak: frameworkTypeLeak,
  metric_threshold: metricThreshold,
  low_cohesion: lowCohesion,
  tool_issue: toolIssue,
};

export type { Severity };
