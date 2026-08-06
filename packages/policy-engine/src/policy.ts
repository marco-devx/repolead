import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { parse } from 'yaml';

import type { Severity } from '@repolead/domain';

export interface PolicyDetectorRef {
  name: string;
  params?: Record<string, unknown>;
}

export interface Policy {
  id: string;
  name: string;
  description: string;
  severity: Severity;
  detectors: PolicyDetectorRef[];
  /** Pregunta que Claude responde por candidato para separar violaciones reales de ruido. */
  judgment: string;
}

interface RawPolicy {
  id?: string;
  name?: string;
  description?: string;
  severity?: string;
  candidate_detectors?: (string | { name?: string; params?: Record<string, unknown> })[];
  llm_judgment?: { question?: string };
}

export function parsePolicy(yamlSource: string, sourcePath: string): Policy {
  const raw = parse(yamlSource) as RawPolicy;
  if (!raw?.id || !raw.severity || !raw.candidate_detectors?.length) {
    throw new Error(`Policy inválida en ${sourcePath}: requiere id, severity y candidate_detectors`);
  }
  return {
    id: raw.id,
    name: raw.name ?? raw.id,
    description: raw.description ?? '',
    severity: raw.severity as Severity,
    detectors: raw.candidate_detectors.map((entry) =>
      typeof entry === 'string' ? { name: entry } : { name: entry.name ?? '', params: entry.params },
    ),
    judgment:
      raw.llm_judgment?.question ??
      'Is this candidate a real violation of the policy, or a harmless implementation detail?',
  };
}

/** Carga recursivamente todas las policies YAML de un directorio versionado. */
export function loadPolicies(directory: string): Policy[] {
  const policies: Policy[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else if (entry.endsWith('.yaml') || entry.endsWith('.yml')) {
        policies.push(parsePolicy(readFileSync(path, 'utf8'), path));
      }
    }
  };
  walk(directory);
  return policies.sort((left, right) => left.id.localeCompare(right.id));
}
