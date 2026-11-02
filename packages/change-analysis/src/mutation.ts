import { lstatSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { executeStryker, mutationPattern, normalizeMutationReport } from '@repolead/adapter-stryker';
import type { MutationTarget, NormalizedMutationReport } from '@repolead/adapter-stryker';
import { contentHash } from '@repolead/domain';
import type { KnowledgeStore } from '@repolead/knowledge-store';

import { listHotspots } from './prioritization';

export interface MutationPlan {
  version: 'hotspot-mutation-v1'; snapshotId: string; repositoryId: string; rootPath: string;
  selection: { module?: string; limit: number };
  inputHash: string; planHash: string; targets: MutationTarget[]; mutate: string[];
  omitted: { symbolId: string; reason: string }[];
  files: { path: string; contentHash: string }[];
}

export function mutationPlan(store: KnowledgeStore, snapshotId: string, options: { module?: string; limit?: number } = {}): MutationPlan {
  const limit = options.limit ?? 3;
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) { throw new Error('Mutation limit must be an integer from 1 to 20 hotspots.'); }
  const snapshot = store.getSnapshot(snapshotId);
  if (!snapshot) { throw new Error('Unknown mutation snapshot.'); }
  const repository = store.getRepository(snapshot.repositoryId)!;
  const targets: MutationTarget[] = []; const omitted: MutationPlan['omitted'] = [];
  let offset: number | null = 0; let inputHash: string;
  do {
    const page = listHotspots(store, snapshotId, { module: options.module, offset, limit: 200 }); inputHash = page.inputHash;
    for (const hotspot of page.items) {
      if (targets.length >= limit) { break; }
      const symbol = store.getSymbol(snapshotId, hotspot.symbolId)!;
      if (!/\.[cm]?[jt]sx?$/.test(symbol.path)) { omitted.push({ symbolId: symbol.id, reason: 'StrykerJS supports JavaScript/TypeScript targets only.' }); continue; }
      if (!symbol.span) { omitted.push({ symbolId: symbol.id, reason: 'Exact UTF-16 span missing; refresh before selecting mutation ranges.' }); continue; }
      const target = { symbolId: symbol.id, path: symbol.path, sourceHash: hotspot.sourceHash,
        startLine: symbol.startLine, endLine: symbol.endLine, startColumn: symbol.span.startColumn, endColumn: symbol.span.endColumn };
      try { mutationPattern(target); } catch (error) { omitted.push({ symbolId: symbol.id, reason: String(error) }); continue; }
      targets.push(target);
    }
    offset = targets.length >= limit ? null : page.nextOffset;
  } while (offset !== null);
  const body = { version: 'hotspot-mutation-v1' as const, snapshotId, repositoryId: repository.id, rootPath: repository.rootPath,
    selection: { ...(options.module === undefined ? {} : { module: options.module }), limit }, inputHash,
    targets, mutate: targets.map(mutationPattern), omitted,
    files: store.listFiles(snapshotId).map((file) => ({ path: file.path, contentHash: file.contentHash })) };
  return { ...body, planHash: contentHash(JSON.stringify(body)) };
}

function verifyPlan(store: KnowledgeStore, plan: MutationPlan, live: boolean) {
  const { planHash, ...body } = plan;
  if (contentHash(JSON.stringify(body)) !== planHash) { throw new Error('Mutation plan was modified.'); }
  if (store.getLatestSnapshot()?.id !== plan.snapshotId) { throw new Error('Mutation snapshot changed; regenerate the plan.'); }
  if (!plan.targets.length) { throw new Error('No eligible hotspots. Mutation execution/import is refused; it never falls back to the whole repository.'); }
  const current = mutationPlan(store, plan.snapshotId, plan.selection);
  if (current.planHash !== plan.planHash) { throw new Error('Mutation plan no longer matches current hotspots, ranges or inputs; regenerate it.'); }
  if (!live) { return; }
  const root = realpathSync(plan.rootPath);
  for (const file of plan.files) {
    const path = resolve(root, file.path); const rel = relative(root, path);
    if (rel === '..' || rel.startsWith(`..${sep}`) || !lstatSync(path).isFile() || !realpathSync(path).startsWith(`${root}${sep}`)
      || contentHash(readFileSync(path)) !== file.contentHash) { throw new Error(`Indexed file changed or unavailable: ${file.path}; refresh before mutation testing.`); }
  }
}

function persist(store: KnowledgeStore, plan: MutationPlan, result: NormalizedMutationReport, reportHash: string, origin: 'executed' | 'imported') {
  verifyPlan(store, plan, false);
  const id = `mutation_${contentHash(JSON.stringify([plan.planHash, reportHash, origin])).slice(0, 32)}`;
  const createdAt = new Date().toISOString();
  store.db.prepare(`INSERT INTO mutation_reports (id, snapshot_id, origin, report_hash, plan_json, result_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`)
    .run(id, plan.snapshotId, origin, reportHash, JSON.stringify(plan), JSON.stringify(result), createdAt);
  return { id, snapshotId: plan.snapshotId, origin, reportHash, counts: result.counts, mutationScore: result.mutationScore, complete: result.complete };
}

export async function runMutationPlan(store: KnowledgeStore, plan: MutationPlan, options: { testCommand: string; timeoutMs?: number; env?: NodeJS.ProcessEnv }) {
  verifyPlan(store, plan, true);
  const execution = await executeStryker({ rootPath: plan.rootPath, targets: plan.targets, ...options });
  verifyPlan(store, plan, true);
  writeFileSync(join(dirname(execution.configPath), 'repolead-plan.json'), JSON.stringify(plan, null, 2) + '\n');
  const report = persist(store, plan, execution.normalized, execution.reportHash, 'executed');
  return { ...report, version: execution.version, configPath: execution.configPath, reportPath: execution.reportPath };
}

export function importMutationReport(store: KnowledgeStore, plan: MutationPlan, reportPath: string) {
  verifyPlan(store, plan, false);
  if (statSync(reportPath).size > 64 * 1024 * 1024) { throw new Error('Mutation report exceeds 64 MiB.'); }
  const text = readFileSync(reportPath, 'utf8');
  return persist(store, plan, normalizeMutationReport(JSON.parse(text), plan.targets), contentHash(text), 'imported');
}

export function mutationResults(store: KnowledgeStore, snapshotId: string, options: { reportId?: string; offset?: number; limit?: number } = {}) {
  const offset = options.offset ?? 0; const limit = options.limit ?? 20;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200) { throw new Error('offset must be nonnegative; limit must be 1–200.'); }
  const rows = store.db.prepare(`SELECT id, origin, report_hash AS reportHash, plan_json, result_json, created_at AS createdAt
    FROM mutation_reports WHERE snapshot_id = ?${options.reportId ? ' AND id = ?' : ''} ORDER BY created_at DESC, rowid DESC LIMIT 1`)
    .all(...(options.reportId ? [snapshotId, options.reportId] : [snapshotId])) as {
      id: string; origin: string; reportHash: string; plan_json: string; result_json: string; createdAt: string;
    }[];
  const row = rows[0];
  if (!row) { return { snapshotId, status: 'not_available' as const, hint: 'No report in this snapshot. Use repolead mutation --run or --report; historical reports are not reused automatically.' }; }
  const plan = JSON.parse(row.plan_json) as MutationPlan; const result = JSON.parse(row.result_json) as NormalizedMutationReport;
  const { mutants, ...summary } = result;
  return { snapshotId, status: 'reported' as const, id: row.id, origin: row.origin, reportHash: row.reportHash, createdAt: row.createdAt,
    targets: plan.targets, ...summary, rankingInputsStillMatch: listHotspots(store, snapshotId, { limit: 1 }).inputHash === plan.inputHash,
    testFreshness: row.origin === 'executed' ? 'Indexed files matched before and after execution; untracked inputs, dependencies and external state are not verified.'
      : 'Unknown: imported report source is verified, execution and test/dependency freshness are not authenticated.',
    mutants: { total: mutants.length, items: mutants.slice(offset, offset + limit), nextOffset: offset + limit < mutants.length ? offset + limit : null } };
}
