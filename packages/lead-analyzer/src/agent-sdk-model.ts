import { query } from '@anthropic-ai/claude-agent-sdk';

import type { ModelCompletion, TechLeadModel } from './model';

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
    this.name = model ?? 'claude-code-default';
  }

  async complete(request: {
    system: string;
    prompt: string;
    schema: Record<string, unknown>;
  }): Promise<ModelCompletion> {
    const stream = query({
      prompt: request.prompt,
      options: {
        systemPrompt: request.system,
        ...(this.model ? { model: this.model } : {}),
        // tools: [] apaga las built-in (Read/Bash/…); el structured output
        // usa un tool interno del harness que no pasa por esta lista. Los
        // turnos extra cubren sus retries.
        maxTurns: 3,
        tools: [],
        outputFormat: { type: 'json_schema', schema: request.schema },
      },
    });

    for await (const message of stream) {
      if (message.type !== 'result') {
        continue;
      }
      if (message.subtype !== 'success') {
        throw new Error(`Claude Code terminó con error: ${message.subtype}`);
      }
      if (message.structured_output === undefined) {
        throw new Error('Claude Code no devolvió structured_output');
      }
      return {
        json: message.structured_output,
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
      };
    }

    throw new Error('El stream del Agent SDK terminó sin mensaje result');
  }
}
