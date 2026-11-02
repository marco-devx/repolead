import type { RepoLeadConfig } from '@repolead/config';
import type { TechLeadModel } from '@repolead/lead-analyzer';
import { AgentSdkTechLeadModel, AnthropicTechLeadModel, OllamaTechLeadModel } from '@repolead/lead-analyzer';

/** Per-process override lets workspace runners set a timeout without editing every repo. */
function localSettingsForRun(settings?: RepoLeadConfig['local_model']): Parameters<typeof OllamaTechLeadModel.connect>[0] {
  const raw = process.env['REPOLEAD_OLLAMA_TIMEOUT_MS'];
  if (raw === undefined) { return settings; }
  const timeoutMs = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) {
    throw new Error('REPOLEAD_OLLAMA_TIMEOUT_MS debe ser un entero entre 1000 y 600000 milisegundos.');
  }
  return { ...settings, timeoutMs };
}

/** Local by default. Remote inference always requires an explicit backend. */
export async function pickModel(backend: string | undefined, modelName: string | undefined,
  localSettings?: RepoLeadConfig['local_model']): Promise<TechLeadModel> {
  if (backend === undefined || backend === 'ollama') {
    try {
      return await OllamaTechLeadModel.connect({ ...localSettingsForRun(localSettings), ...(modelName ? { model: modelName } : {}) });
    } catch (error) {
      throw new Error(`No se pudo iniciar el generador local Ollama: ${error instanceof Error ? error.message : String(error)}. Enciende leaf-model y descarga el modelo configurado. No se utilizará Claude como respaldo.`, { cause: error });
    }
  }
  if (backend === 'api') { return new AnthropicTechLeadModel(modelName); }
  if (backend === 'claude-code') { return new AgentSdkTechLeadModel(modelName); }
  throw new Error('Backend desconocido: usa ollama, api o claude-code.');
}

export function backendLabel(model: TechLeadModel): string {
  if (model instanceof OllamaTechLeadModel) { return 'Ollama local'; }
  if (model instanceof AnthropicTechLeadModel) { return 'API directa'; }
  return model instanceof AgentSdkTechLeadModel ? 'Claude Code (suscripción)' : model.name;
}

export async function pickAnalysisRouting(config: RepoLeadConfig, primary: TechLeadModel) {
  return { analysisMode: config.analysis_mode, symbolSelection: config.symbol_selection,
    criticalModulePaths: config.modules.filter((module) => module.critical).map((module) => module.path),
    leafModel: config.local_model && primary.locality !== 'local' ? await OllamaTechLeadModel.connect(localSettingsForRun(config.local_model)) : undefined };
}
