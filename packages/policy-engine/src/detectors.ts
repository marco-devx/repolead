import type { Severity } from '@repolead/domain';
import type { KnowledgeStore } from '@repolead/knowledge-store';

export interface CandidateEvidence {
  path: string;
  startLine: number | null;
  endLine: number | null;
  excerpt: string | null;
}

export interface Candidate {
  claim: string;
  module: string | null;
  evidence: CandidateEvidence[];
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

function pathOfFileUri(uri: string): string {
  return uri.startsWith('repo://') ? uri.slice(uri.indexOf('/', 'repo://'.length) + 1) : uri;
}

/** module path de cada archivo según los edges CONTAINS de module-detection. */
function fileToModule(store: KnowledgeStore, snapshotId: string): Map<string, string> {
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

/** Ciclos de dependencia entre módulos (A importa de B y B de A). */
const moduleCycle: Detector = (store, snapshotId) => {
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

  const candidates: Candidate[] = [];
  const seenPairs = new Set<string>();
  for (const key of crossModule.keys()) {
    const [from, to] = key.split('\n') as [string, string];
    const reverse = `${to}\n${from}`;
    const pairKey = [from, to].sort().join('\n');
    if (!crossModule.has(reverse) || seenPairs.has(pairKey)) {
      continue;
    }
    seenPairs.add(pairKey);
    const forward = crossModule.get(key)!;
    const backward = crossModule.get(reverse)!;
    candidates.push({
      claim: `Ciclo de dependencia entre módulos: ${from} ↔ ${to}`,
      module: from,
      evidence: [forward, backward].map((edge) => {
        const meta = JSON.parse(edge.evidence_json) as { path?: string; line?: number };
        return {
          path: meta.path ?? pathOfFileUri(edge.source_id),
          startLine: meta.line ?? null,
          endLine: meta.line ?? null,
          excerpt: `${pathOfFileUri(edge.source_id)} → ${pathOfFileUri(edge.target_id)}`,
        };
      }),
    });
  }
  return candidates;
};

/** Símbolos con fan-in por encima del umbral (candidatos a god symbol). */
const highFanIn: Detector = (store, snapshotId, params) => {
  const threshold = typeof params['threshold'] === 'number' ? params['threshold'] : 20;
  const rows = store.db
    .prepare(
      `SELECT s.qualified_name, s.path, s.start_line, s.end_line, COUNT(*) AS fan_in
       FROM edges e JOIN symbols s ON s.id = e.target_id AND s.snapshot_id = e.snapshot_id
       WHERE e.snapshot_id = ? AND e.edge_type IN ('CALLS', 'DEPENDS_ON')
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
      { path: row.path, startLine: row.start_line, endLine: row.end_line, excerpt: row.qualified_name },
    ],
  }));
};

/** Módulos con símbolos suficientes pero sin ningún edge TESTED_BY. */
const untestedModule: Detector = (store, snapshotId, params) => {
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
    if (testedFiles.has(symbol.path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(symbol.path)) {
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
        { path: module.path, startLine: null, endLine: null, excerpt: `module ${module.name}` },
      ],
    }));
};

/** Imports prohibidos por patrón: from (path del archivo) → to (path destino o specifier). */
const forbiddenImport: Detector = (store, snapshotId, params) => {
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
        },
      ],
    }));
};

export const DETECTORS: Record<string, Detector> = {
  module_cycle: moduleCycle,
  high_fan_in: highFanIn,
  untested_module: untestedModule,
  forbidden_import: forbiddenImport,
};

export type { Severity };
