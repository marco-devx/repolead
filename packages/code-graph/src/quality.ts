import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { eligibleSource, normalizeLcov, probeQualityTool, QUALITY_PROFILE, runQualityTool } from '@repolead/adapter-quality';
import type { ImportedCoverage, QualityReport, QualityTool } from '@repolead/adapter-quality';
import { contentHash } from '@repolead/domain';
import type { CoverageRecord, Metric, QualityIssue } from '@repolead/domain';
import type { KnowledgeStore } from '@repolead/knowledge-store';
import { refreshOpportunities } from '@repolead/change-analysis';

export interface QualityOptions {
  store: KnowledgeStore; snapshotId: string; tools?: QualityTool[]; coveragePath?: string;
  env?: NodeJS.ProcessEnv; timeoutMs?: number;
}
export interface QualityToolStatus {
  status: 'complete' | 'partial' | 'failed' | 'unavailable' | 'not_applicable'; version: string | null;
  profile: string; diagnostics: string[]; omittedSources: string[];
}
export interface QualityResult { tools: Record<string, QualityToolStatus & { cached: boolean }>; coverage?: { status: string; diagnostics: string[]; files: number } }

/** Analyze immutable SQLite source, then atomically publish only to the still-current snapshot. */
export async function collectQuality(options: QualityOptions): Promise<QualityResult> {
  const { store, snapshotId } = options;
  const snapshot = store.getSnapshot(snapshotId);
  const repository = snapshot ? store.getRepository(snapshot.repositoryId) : null;
  if (!repository || store.getLatestSnapshot()?.id !== snapshotId) { throw new Error('Quality analysis requires the latest snapshot.'); }
  const files = store.db.prepare('SELECT id, path, content_hash FROM files WHERE snapshot_id = ? ORDER BY path')
    .all(snapshotId) as { id: string; path: string; content_hash: string }[];
  const symbols = store.listSymbols(snapshotId);
  const fileByPath = new Map(files.map((file) => [file.path, file]));
  const sources = new Map<string, string>();
  for (const file of files) { const source = store.getSnapshotSource(snapshotId, file.path); if (source !== null) { sources.set(file.path, source); } }
  const metrics: Metric[] = []; const issues: QualityIssue[] = []; const coverage: CoverageRecord[] = [];
  const cacheWrites: { key: string; tool: string; version: string; result: QualityReport }[] = [];
  const result: QualityResult = { tools: {} };
  const add = (subjectId: string, name: string, value: number, analyzer: string) => metrics.push({ snapshotId, subjectId, name, value, analyzer });
  const selected = [...new Set(options.tools ?? [])].sort();
  for (const tool of selected) {
    const analyzer = `quality:${tool}`;
    const relevant = files.filter((file) => eligibleSource(tool, file.path));
    const omittedSources = relevant.filter((file) => !sources.has(file.path)).map((file) => file.path);
    const base: QualityToolStatus = { status: 'not_applicable', version: null, profile: QUALITY_PROFILE, diagnostics: [], omittedSources };
    if (!relevant.length) { result.tools[tool] = { ...base, cached: false }; continue; }
    const probe = await probeQualityTool(tool, options.env);
    if (probe.status === 'unavailable') {
      result.tools[tool] = { ...base, status: 'unavailable', diagnostics: [probe.message ?? 'Tool unavailable'], cached: false }; continue;
    }
    const key = contentHash(JSON.stringify({ repository: repository.id, tool, version: probe.version, profile: QUALITY_PROFILE,
      sources: relevant.map((file) => [file.path, file.content_hash, sources.has(file.path)]) }));
    const cached = store.db.prepare('SELECT result_json FROM quality_report_cache WHERE cache_key = ?').get(key) as { result_json: string } | undefined;
    try {
      if (relevant.every((file) => !sources.has(file.path))) { throw new Error('No captured source available; refresh the repository.'); }
      const report = cached ? JSON.parse(cached.result_json) as QualityReport : await runQualityTool(probe, sources, options.timeoutMs);
      const diagnostics = [...report.diagnostics];
      for (const measurement of report.measurements) {
        const file = fileByPath.get(measurement.path);
        if (!file) { diagnostics.push(`Unmapped measurement: ${measurement.path}`); continue; }
        if (measurement.symbol) {
          const block = measurement.symbol;
          const matches = symbols.filter((symbol) => symbol.path === file.path && symbol.startLine <= block.startLine && symbol.endLine >= block.endLine
            && (symbol.qualifiedName === block.name || symbol.qualifiedName.endsWith(`.${block.name}`)))
            .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine));
          if (!matches.length) { diagnostics.push(`Unmapped Radon symbol: ${file.path}:${block.startLine} ${block.name}`); continue; }
          add(matches[0]!.id, measurement.name, measurement.value, analyzer);
        } else { add(file.id, measurement.name, measurement.value, analyzer); }
      }
      for (const issue of report.issues) {
        const id = `quality:${contentHash(JSON.stringify([repository.id, analyzer, issue]))}`;
        issues.push({ ...issue, id, snapshotId, analyzer });
      }
      if (!cached) { cacheWrites.push({ key, tool, version: probe.version!, result: report }); }
      result.tools[tool] = { ...base, version: probe.version, status: diagnostics.length || omittedSources.length ? 'partial' : 'complete', diagnostics, cached: Boolean(cached) };
    } catch (error) {
      result.tools[tool] = { ...base, version: probe.version, status: 'failed', diagnostics: [String(error).slice(0, 2000)], cached: false };
    }
  }
  if (options.coveragePath) {
    try {
      const parsed = normalizeLcov(await readFile(resolve(repository.rootPath, options.coveragePath), 'utf8'), { rootPath: repository.rootPath, sources });
      for (const entry of parsed.coverage) {
        coverage.push({ ...entry, snapshotId, analyzer: 'lcov' });
        const file = fileByPath.get(entry.path)!;
        addCoverage(entry, file.id, symbols.filter((symbol) => symbol.path === entry.path));
      }
      result.coverage = { status: parsed.diagnostics.length ? 'partial' : 'complete', diagnostics: parsed.diagnostics, files: coverage.length };
    } catch (error) { result.coverage = { status: 'failed', diagnostics: [String(error).slice(0, 2000)], files: 0 }; }
  }
  function addCoverage(entry: ImportedCoverage, fileId: string, fileSymbols: typeof symbols) {
    if (entry.lineRate !== null) { add(fileId, 'line_coverage', entry.lineRate, 'coverage:lcov'); }
    if (entry.branchRate !== null) { add(fileId, 'branch_coverage', entry.branchRate, 'coverage:lcov'); }
    for (const symbol of fileSymbols) {
      const lines = entry.lines.filter((line) => line.line >= symbol.startLine && line.line <= symbol.endLine);
      if (lines.length) { add(symbol.id, 'line_coverage', lines.filter((line) => line.hits > 0).length / lines.length, 'coverage:lcov'); }
    }
  }
  store.db.transaction(() => {
    if (store.getLatestSnapshot()?.id !== snapshotId) { throw new Error('Snapshot changed during quality analysis; results were not published.'); }
    const status = JSON.parse(store.getSnapshotMetadata(snapshotId, 'metrics_status') ?? '{}') as Record<string, unknown>;
    const external = (status['external'] ?? {}) as Record<string, unknown>;
    for (const tool of selected) {
      store.db.prepare('DELETE FROM metrics WHERE snapshot_id = ? AND analyzer = ?').run(snapshotId, `quality:${tool}`);
      store.db.prepare('DELETE FROM quality_issues WHERE snapshot_id = ? AND analyzer = ?').run(snapshotId, `quality:${tool}`);
      const { cached: _cached, ...stable } = result.tools[tool]!;
      external[tool] = stable;
    }
    if (options.coveragePath) {
      store.db.prepare('DELETE FROM coverage WHERE snapshot_id = ?').run(snapshotId);
      store.db.prepare("DELETE FROM metrics WHERE snapshot_id = ? AND analyzer = 'coverage:lcov'").run(snapshotId);
      status['coverage'] = { ...result.coverage, sourceBinding: 'See each file provenance; report without checksums is unverified.' };
    }
    store.insertMetrics(metrics); store.insertQualityIssues(issues); store.insertCoverage(coverage);
    for (const entry of cacheWrites) {
      store.db.prepare('INSERT OR REPLACE INTO quality_report_cache (cache_key, tool, version, result_json, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(entry.key, entry.tool, entry.version, JSON.stringify(entry.result), new Date().toISOString());
    }
    store.setSnapshotMetadata(snapshotId, 'metrics_status', JSON.stringify({ ...status, external }));
    refreshOpportunities(store, snapshotId);
  })();
  return result;
}
