import Anthropic from '@anthropic-ai/sdk';

export interface ModelCompletion {
  json: unknown;
  inputTokens: number;
  outputTokens: number;
  telemetry?: { provider: string; models: string[]; estimatedCostUsd?: number; durationMs?: number; accounting: string;
    usageBreakdown?: { uncachedInputTokens: number; cacheWriteInputTokens: number; cacheReadInputTokens: number; outputTokens: number; totalTokens: number };
    structuredOutputAttempts?: number; assistantMessages?: number; formattingErrors?: string[];
    batch?: { requests: number; inputTokens: number; outputTokens: number; allocation: 'proportional-proxy' } };
}

export interface ModelRequest { system: string; prompt: string; schema: Record<string, unknown> }

/** A provider response consumed tokens even when its envelope cannot be accepted. */
export class ModelUsageError extends Error {
  constructor(message: string, readonly usage: Pick<ModelCompletion, 'inputTokens' | 'outputTokens'>, options?: ErrorOptions) {
    super(message, options); this.name = 'ModelUsageError';
  }
}

export interface TechLeadModel {
  readonly name: string;
  readonly locality?: 'local' | 'remote';
  complete(request: ModelRequest): Promise<ModelCompletion>;
}

/**
 * Claude como Tech Lead vía Messages API con structured outputs: el schema
 * garantiza JSON válido, y fallbacks server-side cubre declines del clasificador.
 */
export class AnthropicTechLeadModel implements TechLeadModel {
  private readonly client: Anthropic;

  constructor(readonly name: string = 'claude-opus-5') {
    this.client = new Anthropic();
  }

  async complete(request: { system: string; prompt: string; schema: Record<string, unknown> }): Promise<ModelCompletion> {
    const response = await this.client.beta.messages.create({
      model: this.name,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      system: request.system,
      output_config: { format: { type: 'json_schema', schema: request.schema } },
      messages: [{ role: 'user', content: request.prompt }],
      // Los typings del SDK aún no exponen `fallbacks`; el runtime sí lo envía.
      ...({ fallbacks: 'default' } as object),
    });

    if (response.stop_reason === 'refusal') {
      const details = (response as { stop_details?: { category?: string | null } }).stop_details;
      throw new Error(`El modelo declinó el análisis (${details?.category ?? 'sin categoría'})`);
    }

    const text = response.content.find((block) => block.type === 'text')?.text;
    if (!text) {
      throw new Error('El modelo no devolvió contenido de texto');
    }

    return {
      json: JSON.parse(text) as unknown,
      telemetry: { provider: 'anthropic', models: [response.model], accounting: 'API usage including cache read/write input; no invoice attribution' },
      inputTokens:
        response.usage.input_tokens +
        (response.usage.cache_creation_input_tokens ?? 0) +
        (response.usage.cache_read_input_tokens ?? 0),
      outputTokens: response.usage.output_tokens,
    };
  }
}
