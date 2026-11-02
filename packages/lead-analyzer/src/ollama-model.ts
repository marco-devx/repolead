import { contentHash, DEFAULT_LOCAL_MODEL } from '@repolead/domain';
import { z } from 'zod';

import type { TechLeadModel } from './model';

const settingsSchema = z.strictObject({
  url: z.url().default('http://127.0.0.1:11434'),
  model: z.string().min(1).default(DEFAULT_LOCAL_MODEL),
  digest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  context: z.number().int().min(4096).max(262144).default(131072),
  output: z.number().int().min(256).max(16000).default(4096),
  timeoutMs: z.number().int().min(1000).max(600000).default(180000),
});
export type OllamaSettings = z.input<typeof settingsSchema>;

/** Local generator for every analysis level and policy judgments. Embeddings use TEI. */
export class OllamaTechLeadModel implements TechLeadModel {
  readonly name: string;
  readonly locality = 'local' as const;
  private constructor(private readonly settings: z.output<typeof settingsSchema>, readonly digest: string) {
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
    const requiredContext = Buffer.byteLength(request.system + request.prompt + schema, 'utf8') + settings.output + 1024;
    if (requiredContext > settings.context) {
      throw new Error('Local model context budget exceeded; reduce evidence or increase local_model.context.');
    }
    if (await OllamaTechLeadModel.resolveDigest(settings) !== this.digest) { throw new Error('Ollama model changed; reconnect before analysis.'); }
    const started = Date.now();
    const response = await fetch(`${settings.url}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(settings.timeoutMs), body: JSON.stringify({ model: settings.model, stream: false,
        messages: [{ role: 'system', content: request.system }, { role: 'user', content: `${request.prompt}\nJSON schema: ${schema}` }],
        format: request.schema, think: false,
        options: { temperature: 0, num_ctx: Math.min(settings.context, Math.ceil(requiredContext / 4096) * 4096), num_predict: settings.output }, keep_alive: '30s' }) });
    if (!response.ok) { throw new Error(`Ollama generation: HTTP ${response.status}`); }
    const data = z.object({ done: z.literal(true), done_reason: z.string(),
      message: z.object({ content: z.string().min(1).max(1000000) }),
      prompt_eval_count: z.number().int().nonnegative(), eval_count: z.number().int().nonnegative() }).parse(await response.json());
    if (data.done_reason !== 'stop') { throw new Error(`Ollama generation incomplete: ${data.done_reason}`); }
    if (await OllamaTechLeadModel.resolveDigest(settings) !== this.digest) { throw new Error('Ollama model changed during generation; result discarded.'); }
    return { json: JSON.parse(data.message.content) as unknown, inputTokens: data.prompt_eval_count, outputTokens: data.eval_count,
      telemetry: { provider: 'ollama-local', models: [this.name], durationMs: Date.now() - started,
        accounting: 'Local prompt_eval_count/eval_count; not remote billable tokens; excludes hardware and electricity costs.' } };
  }
}
