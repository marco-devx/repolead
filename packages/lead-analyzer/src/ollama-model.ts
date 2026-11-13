import { contentHash, DEFAULT_LOCAL_MODEL } from '@repolead/domain';
import { z } from 'zod';

import type { TechLeadModel } from './model';
import { ModelUsageError } from './model';

const MAX_OUTPUT = 16000;
const MAX_GENERATION_ATTEMPTS = 3;

const settingsSchema = z.strictObject({
  url: z.url().default('http://127.0.0.1:11434'),
  model: z.string().min(1).default(DEFAULT_LOCAL_MODEL),
  digest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  context: z.number().int().min(4096).max(262144).default(131072),
  output: z.number().int().min(256).max(MAX_OUTPUT).default(4096),
  timeoutMs: z.number().int().min(1000).max(600000).default(180000),
});
export type OllamaSettings = z.input<typeof settingsSchema>;

/** Local generator for every analysis level and policy judgments. Embeddings use TEI. */
export class OllamaTechLeadModel implements TechLeadModel {
  readonly name: string;
  readonly locality = 'local' as const;
  private constructor(private readonly settings: z.output<typeof settingsSchema>, readonly digest: string) {
    // Keep existing valid summaries reusable. Length recovery changes only previously failed requests;
    // the initial request, model weights, prompts and configured output budget stay identical.
    this.name = `ollama:${settings.model}@${digest}:${contentHash(JSON.stringify({ url: settings.url,
      context: settings.context, output: settings.output, temperature: 0, think: false, version: 2 }))}`;
  }

  static async connect(input: OllamaSettings = {}): Promise<OllamaTechLeadModel> {
    const settings = settingsSchema.parse(input);
    const url = new URL(settings.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('Ollama requires an HTTP(S) URL without credentials, query or fragment.');
    }
    settings.url = settings.url.replace(/\/+$/, '');
    const digest = await this.resolveDigest(settings);
    if (settings.digest && settings.digest !== digest) { throw new Error('Ollama model digest differs from configured digest.'); }
    return new OllamaTechLeadModel(settings, digest);
  }

  private static async resolveDigest(settings: z.output<typeof settingsSchema>): Promise<string> {
    const response = await fetch(`${settings.url}/api/tags`, { signal: AbortSignal.timeout(Math.min(settings.timeoutMs, 10000)) });
    if (!response.ok) { throw new Error(`Ollama tags: HTTP ${response.status}`); }
    const tags = z.object({ models: z.array(z.object({ name: z.string(), digest: z.string().regex(/^[a-f0-9]{64}$/) })) }).parse(await response.json());
    const model = tags.models.find((entry) => entry.name === settings.model);
    if (!model) { throw new Error(`Ollama model ${settings.model} is not installed; pull it explicitly first.`); }
    return model.digest;
  }

  async complete(request: Parameters<TechLeadModel['complete']>[0]): ReturnType<TechLeadModel['complete']> {
    const { settings } = this;
    // UTF-8 bytes conservatively bound Qwen's byte-level tokenizer; reserve space for chat framing.
    const schema = JSON.stringify(request.schema);
    const inputContext = Buffer.byteLength(request.system + request.prompt + schema, 'utf8') + 1024;
    if (inputContext + settings.output > settings.context) {
      throw new Error('Local model context budget exceeded; reduce evidence or increase local_model.context.');
    }
    const started = Date.now();
    let inputTokens = 0; let outputTokens = 0; let output = settings.output;
    try {
      for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt += 1) {
        if (await OllamaTechLeadModel.resolveDigest(settings) !== this.digest) { throw new Error('Ollama model changed; reconnect before analysis.'); }
        const requiredContext = inputContext + output;
        const response = await fetch(`${settings.url}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' },
          signal: AbortSignal.timeout(settings.timeoutMs), body: JSON.stringify({ model: settings.model, stream: false,
            messages: [{ role: 'system', content: request.system }, { role: 'user', content: `${request.prompt}\nJSON schema: ${schema}` }],
            format: request.schema, think: false,
            options: { temperature: 0, num_ctx: Math.min(settings.context, Math.ceil(requiredContext / 4096) * 4096), num_predict: output }, keep_alive: '30s' }) });
        if (!response.ok) { throw new Error(`Ollama generation: HTTP ${response.status}`); }
        const data = z.object({ done: z.literal(true), done_reason: z.string(),
          message: z.object({ content: z.string().max(1000000) }),
          prompt_eval_count: z.number().int().nonnegative(), eval_count: z.number().int().nonnegative() }).parse(await response.json());
        inputTokens += data.prompt_eval_count; outputTokens += data.eval_count;
        if (await OllamaTechLeadModel.resolveDigest(settings) !== this.digest) { throw new Error('Ollama model changed during generation; result discarded.'); }
        if (data.done_reason === 'length') {
          const nextOutput = Math.min(output * 2, MAX_OUTPUT, settings.context - inputContext);
          if (attempt === MAX_GENERATION_ATTEMPTS || nextOutput <= output) {
            throw new Error(`Ollama generation incomplete: length after ${attempt} attempt(s), output limit ${output} tokens. Incomplete JSON discarded; completed summaries remain cached. Split the failing synthesis into smaller evidence groups.`);
          }
          console.warn(`Ollama: respuesta cortada por longitud (${output} tokens); reintento ${attempt}/${MAX_GENERATION_ATTEMPTS - 1} con hasta ${nextOutput} tokens. La caché completada se conserva.`);
          output = nextOutput;
          continue;
        }
        if (data.done_reason !== 'stop') { throw new Error(`Ollama generation incomplete: ${data.done_reason}`); }
        return { json: JSON.parse(data.message.content) as unknown, inputTokens, outputTokens,
          telemetry: { provider: 'ollama-local', models: [this.name], durationMs: Date.now() - started,
            generationAttempts: attempt,
            accounting: 'Local prompt_eval_count/eval_count across all attempts, including truncated outputs; not remote billable tokens; excludes hardware and electricity costs.' } };
      }
      throw new Error('Ollama generation attempts exhausted.');
    } catch (error) {
      if (inputTokens || outputTokens) {
        throw new ModelUsageError(error instanceof Error ? error.message : String(error), { inputTokens, outputTokens }, { cause: error });
      }
      throw error;
    }
  }
}
