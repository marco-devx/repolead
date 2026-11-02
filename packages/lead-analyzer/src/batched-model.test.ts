import { expect, test } from '@rstest/core';
import { contentHash, fileUri, moduleUri, stableSymbolId } from '@repolead/domain';
import { openStore } from '@repolead/knowledge-store';
import { BatchedTechLeadModel, forAnalysisBatches } from './batched-model';
import { analyzeSnapshot } from './analyze';
import type { ModelRequest, TechLeadModel } from './model';
import type { HierarchicalPack } from './hierarchy';

class BatchContract implements TechLeadModel {
  name = 'batch-contract';
  requests: ModelRequest[] = [];
  crossCiteOnce = false;
  missingOnce = false;
  async complete(request: ModelRequest) {
    this.requests.push(request);
    const batch = request.prompt.startsWith('{') ? JSON.parse(request.prompt) as { independentTasks: { id: string; task: string }[] } : null;
    const empty = (schema: Record<string, unknown>): unknown => schema['type'] === 'array' ? [] : schema['type'] === 'object'
      ? Object.fromEntries(Object.entries(schema['properties'] as Record<string, Record<string, unknown>>).map(([key, value]) => [key, empty(value)])) : 'Contract, not semantic validation';
    const answer = (prompt: string, schema: Record<string, unknown>) => {
      const pack = JSON.parse(prompt.split('Evidence pack:\n')[1]!.split('\n\nReturn ')[0]!) as HierarchicalPack;
      return { ...empty(schema) as object, evidenceIds: pack.evidence.map((entry) => entry.id) };
    };
    let json: unknown;
    if (batch) {
      const result = Object.fromEntries(batch.independentTasks.map(({ id, task }) => [id, answer(task, (request.schema['properties'] as Record<string, Record<string, unknown>>)[id]!)]));
      if (this.crossCiteOnce) { result['C1']!.evidenceIds = result['C2']!.evidenceIds; this.crossCiteOnce = false; }
      if (this.missingOnce) { delete result['C1']; this.missingOnce = false; }
      json = result;
    } else { json = answer(request.prompt, request.schema); }
    return { json, inputTokens: 101, outputTokens: 17 };
  }
}

async function fixture() {
  const store = await openStore(':memory:');
  const repo = store.upsertRepository({ name: 'batch', rootPath: '/not-mounted' });
  const snapshot = store.createSnapshot({ repositoryId: repo.id, commitSha: 'one' });
  store.insertModules([{ id: moduleUri(repo.name, '.'), repositoryId: repo.id, snapshotId: snapshot.id, name: 'root', path: '.' }]);
  for (const name of ['one', 'two']) {
    const path = `${name}.ts`; const source = `export function ${name}() { return "${name}"; }`;
    store.insertFiles([{ id: fileUri(repo.name, path), repositoryId: repo.id, snapshotId: snapshot.id, path,
      contentHash: contentHash(source), language: 'typescript', lineCount: 1, lastAuthor: null, lastCommitAt: null }]);
    store.insertSnapshotSources(snapshot.id, [{ path, content: source, contentHash: contentHash(source) }]);
    store.insertSymbols([{ id: stableSymbolId({ repository: repo.name, path, kind: 'function', qualifiedName: name }), repositoryId: repo.id,
      snapshotId: snapshot.id, path, qualifiedName: name, kind: 'function', signature: null, startLine: 1, endLine: 1,
      contentHash: contentHash(source), source: 'tree-sitter' }]);
  }
  return { store, snapshot };
}

test('batched hierarchy preserves every subject and exact total usage, isolates schema references and makes zero calls on repeat', async () => {
  const { store, snapshot } = await fixture();
  const model = new BatchContract();
  try {
    const options = { store, snapshotId: snapshot.id, model, budget: { batchSize: 4, maxTokens: 4000 } };
    const first = await analyzeSnapshot(options);
    expect(model.requests).toHaveLength(4); // two symbols, two files, one module, one repository.
    expect(store.listSummaries(snapshot.id)).toHaveLength(6);
    expect(first.inputTokens).toBe(404); expect(first.outputTokens).toBe(68);
    const usage = store.db.prepare('SELECT SUM(input_tokens) AS input, SUM(output_tokens) AS output FROM analysis_runs').get() as { input: number; output: number };
    expect(usage).toEqual({ input: 404, output: 68 });
    const schema = JSON.stringify(model.requests[0]!.schema);
    expect(schema).toContain('#/$defs/C1_evidenceId'); expect(schema).toContain('#/$defs/C2_evidenceId');
    expect(schema).not.toContain('"$ref":"#/$defs/evidenceId"');
    const repeat = await analyzeSnapshot(options);
    expect(repeat.symbolsCached).toBe(2); expect(repeat.inputTokens).toBe(0); expect(model.requests).toHaveLength(4);
    for (const summary of store.listSummaries(snapshot.id)) {
      expect(summary.model).toContain('independent-batch-v1');
      expect(store.getSummaryEvidence(summary.id).length).toBeGreaterThan(0);
    }
  } finally { store.close(); }
});

test('cross-task citations trigger only the invalid task retry; incomplete envelopes persist no partial result', async () => {
  for (const missing of [false, true]) {
    const { store, snapshot } = await fixture(); const model = new BatchContract();
    model.crossCiteOnce = !missing; model.missingOnce = missing;
    try {
      const options = { store, snapshotId: snapshot.id, model, budget: { batchSize: 2 } };
      if (missing) {
        await expect(analyzeSnapshot(options)).rejects.toThrow('Incomplete');
        expect(store.listSummaries(snapshot.id)).toHaveLength(0);
        expect(store.db.prepare('SELECT SUM(input_tokens) AS input, SUM(output_tokens) AS output FROM analysis_runs').get())
          .toEqual({ input: 101, output: 17 });
        await analyzeSnapshot(options);
        expect(store.listSummaries(snapshot.id)).toHaveLength(6);
      } else {
        const result = await analyzeSnapshot(options);
        expect(model.requests).toHaveLength(5);
        expect(result.inputTokens).toBe(505); expect(result.outputTokens).toBe(85);
        expect(model.requests[1]!.prompt).toContain('failed validation');
        expect(store.listSummaries(snapshot.id)).toHaveLength(6);
      }
    } finally { store.close(); }
  }
});

test('different systems and oversized requests use separate untruncated calls, and failed groups settle before the store can close', async () => {
  const calls: ModelRequest[] = [];
  const base: TechLeadModel = { name: 'raw', complete: async (request) => { calls.push(request); return { json: {}, inputTokens: 1, outputTokens: 1 }; } };
  const model = new BatchedTechLeadModel(base, 4, 256);
  const requests = ['first', 'second', 'first'].map((system) => ({ system, prompt: 'whole source '.repeat(300), schema: { type: 'object' } }));
  await Promise.all(requests.map((request) => model.complete(request)));
  expect(calls).toEqual(requests);
  let settled = false;
  await expect(forAnalysisBatches([1, 2], 2, async (item) => {
    if (item === 1) { throw new Error('first failed'); }
    await new Promise((resolve) => setTimeout(resolve, 15)); settled = true;
  })).rejects.toThrow('first failed');
  expect(settled).toBe(true);
});
