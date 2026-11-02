import type { ModelCompletion, TechLeadModel } from './model';
import { ModelUsageError } from './model';

/**
 * Backend alternativo: Claude Code como motor, vía Agent SDK. Usa la
 * autenticación existente de Claude Code (suscripción Pro/Max) en vez de
 * créditos de API. `outputFormat: json_schema` garantiza el JSON igual que
 * structured outputs en la API directa.
 */
export class AgentSdkTechLeadModel implements TechLeadModel {
  readonly name: string;

  /** Sin modelo explícito se usa el default del CLI del usuario. */
  constructor(private readonly model?: string) {
    this.name = `claude-code:${model ?? 'default'}:isolated-v1`;
  }

  async complete(request: {
    system: string;
    prompt: string;
    schema: Record<string, unknown>;
  }): Promise<ModelCompletion> {
    // Import dinámico: el SDK es ESM y el CLI compilado es CJS — require(ESM)
    // dispara el ExperimentalWarning de Node; import() no. Además solo se
    // carga cuando este backend se usa de verdad.
    const { query } = await import(/* webpackIgnore: true */ '@anthropic-ai/claude-agent-sdk');
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 120000);
    const stream = query({
      prompt: request.prompt,
      options: {
        systemPrompt: request.system,
        // Evidence interpretation must not inherit project/user hooks, skills or CLAUDE.md.
        settingSources: [],
        skills: [],
        mcpServers: {},
        strictMcpConfig: true,
        abortController,
        ...(this.model ? { model: this.model } : {}),
        // tools: [] apaga las built-in (Read/Bash/…); el structured output
        // usa un tool interno del harness que no pasa por esta lista. Los
        // turnos extra cubren sus retries.
        maxTurns: 3,
        tools: [],
        outputFormat: { type: 'json_schema', schema: request.schema },
      },
    });

    let structuredOutputAttempts = 0;
    const assistantMessages = new Set<string>();
    const formattingErrors: string[] = [];
    try { for await (const message of stream) {
      if (message.type === 'assistant') {
        assistantMessages.add(message.message.id);
        for (const block of message.message.content) { if (block.type === 'tool_use' && block.name === 'StructuredOutput') { structuredOutputAttempts += 1; } }
      }
      if (message.type === 'user' && Array.isArray(message.message.content)) {
        for (const block of message.message.content) {
          if (block.type === 'tool_result' && block.is_error && formattingErrors.length < 8) { formattingErrors.push(JSON.stringify(block.content).slice(0, 800)); }
        }
      }
      if (message.type !== 'result') {
        continue;
      }
      if (message.subtype !== 'success') {
        throw new ModelUsageError(`Claude Code terminó con error: ${message.subtype}${message.errors.length ? ` (${message.errors.join('; ').slice(0, 1000)})` : ''}`, sdkTokenUsage(message));
      }
      if (message.structured_output === undefined) {
        throw new ModelUsageError('Claude Code no devolvió structured_output', sdkTokenUsage(message));
      }
      // input_tokens es solo el remanente no cacheado: el total real del
      // prompt incluye lo que entra y sale del prompt cache.
      const usage = sdkTokenUsage(message);
      return {
        json: message.structured_output,
        ...usage,
        telemetry: { provider: 'claude-code', models: Object.keys(message.modelUsage),
          estimatedCostUsd: message.total_cost_usd, durationMs: message.duration_ms,
          usageBreakdown: sdkTokenBreakdown(message), structuredOutputAttempts, assistantMessages: assistantMessages.size, formattingErrors,
          accounting: 'SDK query-pipeline totals including cache input; cost estimate, not subscription billing' },
      };
    }

    throw new Error('El stream del Agent SDK terminó sin mensaje result');
    } catch (error) {
      if (abortController.signal.aborted && !(error instanceof ModelUsageError)) { throw new Error('Claude Code analysis exceeded its 120000 ms timeout.', { cause: error }); }
      throw error;
    } finally { clearTimeout(timeout); stream.close(); }
  }
}

interface SdkUsage {
  modelUsage?: Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }>;
  usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
}

export function sdkTokenBreakdown(message: SdkUsage) {
  const totals = Object.values(message.modelUsage ?? {});
  const counts = totals.length ? {
    uncachedInputTokens: totals.reduce((sum, usage) => sum + usage.inputTokens, 0),
    cacheWriteInputTokens: totals.reduce((sum, usage) => sum + usage.cacheCreationInputTokens, 0),
    cacheReadInputTokens: totals.reduce((sum, usage) => sum + usage.cacheReadInputTokens, 0),
    outputTokens: totals.reduce((sum, usage) => sum + usage.outputTokens, 0),
  } : { uncachedInputTokens: message.usage.input_tokens, cacheWriteInputTokens: message.usage.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: message.usage.cache_read_input_tokens ?? 0, outputTokens: message.usage.output_tokens };
  return { ...counts, totalTokens: Object.values(counts).reduce((sum, count) => sum + count, 0) };
}

export function sdkTokenUsage(message: SdkUsage): Pick<ModelCompletion, 'inputTokens' | 'outputTokens'> {
  const counts = sdkTokenBreakdown(message);
  return { inputTokens: counts.uncachedInputTokens + counts.cacheWriteInputTokens + counts.cacheReadInputTokens, outputTokens: counts.outputTokens };
}
