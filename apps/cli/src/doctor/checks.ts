import { probeJoern } from '@repolead/adapter-joern';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

import { resolveScipEntrypoint } from '@repolead/adapter-scip';
import { probeQualityTool, QUALITY_TOOLS } from '@repolead/adapter-quality';
import { probeStryker } from '@repolead/adapter-stryker';

const run = promisify(execFile);

export interface DoctorResult {
  name: string;
  ok: boolean;
  required: boolean;
  detail: string;
  hint?: string;
}

interface CheckOptions {
  required: boolean;
  hint: string;
}

async function checkBinary(
  name: string,
  command: string,
  args: string[],
  options: CheckOptions,
): Promise<DoctorResult> {
  try {
    const { stdout } = await run(command, args);
    return {
      name,
      ok: true,
      required: options.required,
      detail: stdout.trim().split('\n')[0] ?? '',
    };
  } catch {
    return {
      name,
      ok: false,
      required: options.required,
      detail: 'no encontrado',
      hint: options.hint,
    };
  }
}

async function checkService(name: string, url: string, options: CheckOptions): Promise<DoctorResult> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return {
      name,
      ok: response.ok,
      required: options.required,
      detail: `${url} → HTTP ${response.status}`,
      hint: response.ok ? undefined : options.hint,
    };
  } catch {
    return {
      name,
      ok: false,
      required: options.required,
      detail: `${url} inaccesible`,
      hint: options.hint,
    };
  }
}

export async function runDoctorChecks(env: NodeJS.ProcessEnv = process.env): Promise<DoctorResult[]> {
  const qdrantUrl = env['REPOLEAD_QDRANT_URL'] ?? 'http://localhost:6333';
  const teiUrl = env['REPOLEAD_TEI_URL'] ?? 'http://localhost:8080';

  return Promise.all([
    probeJoern(env).then((probe): DoctorResult => ({ name: 'joern', ok: probe.available, required: false,
      detail: probe.detail, hint: 'Install a pinned Joern distribution and set REPOLEAD_JOERN_BIN to its absolute launcher path.' })),
    checkService('ollama (optional leaf model)', `${env['REPOLEAD_OLLAMA_URL'] ?? 'http://127.0.0.1:11434'}/api/tags`, {
      required: false, hint: 'docker compose --profile leaf up -d leaf-model; pull qwen3.5:9b-q4_K_M and configure local_model explicitly',
    }),
    probeStryker(env).then((probe): DoctorResult => ({ name: 'stryker', ok: probe.available, required: false,
      detail: probe.version ?? probe.message ?? 'no disponible', hint: 'bun install en RepoLead (Stryker 10.1.1, Node >=22); overrides REPOLEAD_STRYKER_BIN / REPOLEAD_NODE_BIN' })),
    ...QUALITY_TOOLS.map(async (tool): Promise<DoctorResult> => {
      const probe = await probeQualityTool(tool, env);
      return { name: tool, ok: probe.status === 'available', required: false,
        detail: probe.version ?? probe.message ?? 'no disponible',
        hint: tool === 'jscpd' ? 'bun install en RepoLead, o REPOLEAD_JSCPD_BIN' : 'instala services/quality/requirements.txt en .repolead-tools/python; overrides: REPOLEAD_RUFF_BIN / REPOLEAD_QUALITY_PYTHON' };
    }),
    checkBinary('bun', 'bun', ['--version'], {
      required: true,
      hint: 'instala Bun: https://bun.sh',
    }),
    checkBinary('git', 'git', ['--version'], {
      required: true,
      hint: 'instala git con tu gestor de paquetes',
    }),
    checkBinary('docker', 'docker', ['--version'], {
      required: false,
      hint: 'necesario para Qdrant y TEI: https://docs.docker.com/engine/install/',
    }),
    ...(['typescript', 'python'] as const).map((language): DoctorResult => {
      const entry = resolveScipEntrypoint(language);
      return { name: `scip-${language}`, ok: Boolean(entry && existsSync(entry)), required: false,
        detail: entry && existsSync(entry) ? `indexador instalado: ${entry}` : 'indexador no disponible',
        hint: 'ejecuta bun install en RepoLead; doctor --db muestra fallos del último scan' };
    }),
    checkService('qdrant', `${qdrantUrl}/healthz`, {
      required: false,
      hint: 'levántalo con: docker compose up -d qdrant',
    }),
    checkService('embeddings (TEI)', `${teiUrl}/health`, {
      required: false,
      hint: 'levántalo con: docker compose up -d embeddings',
    }),
    checkService('reranker (TEI)', `${env['REPOLEAD_RERANKER_URL'] ?? 'http://localhost:8081'}/health`, {
      required: false,
      hint: 'levántalo con: docker compose up -d reranker',
    }),
  ]);
}
