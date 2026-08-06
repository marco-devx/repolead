import type { TechLeadModel } from '@repolead/lead-analyzer';
import { AgentSdkTechLeadModel, AnthropicTechLeadModel } from '@repolead/lead-analyzer';

/**
 * Con credenciales de API se usa la Messages API directa; sin ellas, el
 * Agent SDK con la sesión de Claude Code del usuario (suscripción Pro/Max).
 */
export function pickModel(backend: string | undefined, modelName: string | undefined): TechLeadModel {
  const hasApiCredentials = Boolean(
    process.env['ANTHROPIC_API_KEY'] ?? process.env['ANTHROPIC_AUTH_TOKEN'],
  );
  const useApi = backend === 'api' || (backend !== 'claude-code' && hasApiCredentials);
  return useApi ? new AnthropicTechLeadModel(modelName) : new AgentSdkTechLeadModel(modelName);
}

export function backendLabel(model: TechLeadModel): string {
  return model instanceof AnthropicTechLeadModel ? 'API directa' : 'Claude Code (suscripción)';
}
