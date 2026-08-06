import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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
    checkBinary('scip-typescript', 'scip-typescript', ['--version'], {
      required: false,
      hint: 'se usa desde la Fase 3: bun add -g @sourcegraph/scip-typescript',
    }),
    checkService('qdrant', `${qdrantUrl}/healthz`, {
      required: false,
      hint: 'levántalo con: docker compose up -d qdrant',
    }),
    checkService('embeddings (TEI)', `${teiUrl}/health`, {
      required: false,
      hint: 'levántalo con: docker compose up -d embeddings',
    }),
  ]);
}
