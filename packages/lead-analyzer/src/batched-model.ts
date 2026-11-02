import { DEFAULT_CONTEXT_TOKENS } from '@repolead/domain';
import { countTokens } from '@repolead/retrieval';
import type { ModelCompletion, ModelRequest, TechLeadModel } from './model';
import { ModelUsageError } from './model';

export function analysisBatchSize(value = 1): number {
  if (!Number.isInteger(value) || value < 1 || value > 4) { throw new Error('Analysis batch size must be an integer between 1 and 4.'); }
  return value;
}

interface Pending { request: ModelRequest; resolve: (result: ModelCompletion) => void; reject: (error: unknown) => void }

/** Independent tasks share provider overhead; each result still passes its own schema/provenance validation. */
export class BatchedTechLeadModel implements TechLeadModel {
  readonly name: string;
  get locality() { return this.base.locality; }
  private readonly pending: Pending[] = [];
  private draining = false;
  constructor(private readonly base: TechLeadModel, readonly size = 4, private readonly maxInputTokens = DEFAULT_CONTEXT_TOKENS) {
    analysisBatchSize(size);
    if (!Number.isInteger(maxInputTokens) || maxInputTokens < 256 || maxInputTokens > 256000) { throw new Error('Invalid model batch input budget.'); }
    this.name = `${base.name}:independent-batch-v1`;
  }

  complete(request: ModelRequest): Promise<ModelCompletion> {
    const promise = new Promise<ModelCompletion>((resolve, reject) => this.pending.push({ request, resolve, reject }));
    if (!this.draining) { this.draining = true; queueMicrotask(() => { void this.drain(); }); }
    return promise;
  }

  private async drain(): Promise<void> {
    try {
      while (this.pending.length) {
        const group = [this.pending.shift()!];
        while (group.length < this.size && this.pending.length && this.pending[0]!.request.system === group[0]!.request.system) {
          const candidate = [...group, this.pending[0]!];
          let joined: ModelRequest;
          try { joined = combinedRequest(candidate.map((entry) => entry.request)); } catch { break; }
          if (countTokens(joined.system + joined.prompt + JSON.stringify(joined.schema)) > this.maxInputTokens) { break; }
          group.push(this.pending.shift()!);
        }
        let measured: Pick<ModelCompletion, 'inputTokens' | 'outputTokens'> | undefined;
        try {
          if (group.length === 1) { group[0]!.resolve(await this.base.complete(group[0]!.request)); continue; }
          const response = await this.base.complete(combinedRequest(group.map((entry) => entry.request)));
          measured = response;
          const json = response.json;
          const keys = group.map((_, i) => `C${i + 1}`);
          if (!json || typeof json !== 'object' || Array.isArray(json) || Object.keys(json).length !== keys.length
            || keys.some((key) => !Object.hasOwn(json, key))) { throw new Error('Incomplete or unexpected model batch result; no task can consume another task result.'); }
          const objects = json as Record<string, unknown>;
          const inputs = allocate(response.inputTokens, group.map(({ request }) => countTokens(request.prompt + JSON.stringify(request.schema))));
          const outputs = allocate(response.outputTokens, keys.map((key) => countTokens(JSON.stringify(objects[key]))));
          group.forEach((entry, i) => entry.resolve({ json: objects[keys[i]!], inputTokens: inputs[i]!, outputTokens: outputs[i]!,
            telemetry: { provider: response.telemetry?.provider ?? 'batch', models: response.telemetry?.models ?? [this.base.name],
              ...(response.telemetry?.estimatedCostUsd !== undefined ? { estimatedCostUsd: response.telemetry.estimatedCostUsd
                * (response.inputTokens + response.outputTokens ? (inputs[i]! + outputs[i]!) / (response.inputTokens + response.outputTokens) : 1 / group.length) } : {}),
              durationMs: response.telemetry?.durationMs,
              accounting: 'Batch totals from provider; per-task token attribution is proportional to o200k_base request/output size, not per-task billing.',
              batch: { requests: group.length, inputTokens: response.inputTokens, outputTokens: response.outputTokens, allocation: 'proportional-proxy' } } }));
        } catch (error) {
          const usage = measured ?? (error instanceof ModelUsageError ? error.usage : undefined);
          if (usage && Number.isSafeInteger(usage.inputTokens) && usage.inputTokens >= 0 && Number.isSafeInteger(usage.outputTokens) && usage.outputTokens >= 0) {
            const weights = group.map(({ request }) => countTokens(request.prompt + JSON.stringify(request.schema)));
            const inputs = allocate(usage.inputTokens, weights); const outputs = allocate(usage.outputTokens, weights);
            group.forEach((entry, i) => entry.reject(new ModelUsageError(error instanceof Error ? error.message : String(error),
              { inputTokens: inputs[i]!, outputTokens: outputs[i]! }, { cause: error })));
          } else { group.forEach((entry) => entry.reject(error)); }
        }
      }
    } finally { this.draining = false; }
  }
}

function allocate(total: number, weights: number[]): number[] {
  if (!Number.isSafeInteger(total) || total < 0) { throw new Error('Invalid provider batch token usage.'); }
  const sum = weights.reduce((value, weight) => value + Math.max(1, weight), 0);
  let allocated = 0;
  return weights.map((weight, i) => {
    const value = i === weights.length - 1 ? total - allocated : Math.floor(total * Math.max(1, weight) / sum);
    allocated += value; return value;
  });
}

function combinedRequest(requests: ModelRequest[]): ModelRequest {
  const definitions: Record<string, unknown> = {}; const properties: Record<string, unknown> = {};
  const prompts: { id: string; task: string }[] = [];
  requests.forEach((request, index) => {
    const id = `C${index + 1}`; const defs = request.schema['$defs'] as Record<string, unknown> | undefined;
    const rewrite = (value: unknown): unknown => {
      if (Array.isArray(value)) { return value.map(rewrite); }
      if (!value || typeof value !== 'object') { return value; }
      return Object.fromEntries(Object.entries(value).map(([key, item]) => {
        if (key !== '$ref') { return [key, rewrite(item)]; }
        if (typeof item !== 'string' || !item.startsWith('#/$defs/')) { throw new Error('Schema reference cannot be isolated in a batch.'); }
        const name = item.slice('#/$defs/'.length).split('/')[0]!;
        if (!defs || !Object.hasOwn(defs, name)) { throw new Error('Unresolved batch schema reference.'); }
        return [key, `#/$defs/${id}_${item.slice('#/$defs/'.length)}`];
      }));
    };
    const { $defs: _defs, ...schema } = request.schema;
    properties[id] = rewrite(schema);
    for (const [name, definition] of Object.entries(defs ?? {})) { definitions[`${id}_${name}`] = rewrite(definition); }
    prompts.push({ id, task: request.prompt });
  });
  return { system: `${requests[0]!.system}\nIndependent batch protocol: each task has its own evidence and output schema. Analyze tasks independently. Never use another task's source, claims or citation IDs. Return exactly one result per supplied task ID.`,
    prompt: JSON.stringify({ independentTasks: prompts }),
    schema: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false, $defs: definitions } };
}

/** Wait for every task in a group before allowing callers to close their store after an error. */
export async function forAnalysisBatches<T>(items: T[], size: number, operation: (item: T) => Promise<void>): Promise<void> {
  analysisBatchSize(size);
  for (let start = 0; start < items.length; start += size) {
    const settled = await Promise.allSettled(items.slice(start, start + size).map((item) => Promise.resolve().then(() => operation(item))));
    const failure = settled.find((entry) => entry.status === 'rejected');
    if (failure?.status === 'rejected') { throw failure.reason; }
  }
}
