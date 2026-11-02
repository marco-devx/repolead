import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { parseDocument } from 'yaml';
import { z } from 'zod';

import { SEVERITIES } from '@repolead/domain';
import type { Severity } from '@repolead/domain';

export const EVIDENCE_REQUIREMENTS = ['location', 'source_symbol', 'target_symbol', 'dependency_path', 'metric', 'test_links', 'source_excerpt'] as const;

export interface PolicyDetectorRef {
  name: string;
  params?: Record<string, unknown>;
}

export interface Policy {
  id: string;
  version: string;
  name: string;
  description: string;
  severity: Severity;
  detectors: PolicyDetectorRef[];
  requiredEvidence: (typeof EVIDENCE_REQUIREMENTS)[number][];
  /** Pregunta que Claude responde por candidato para separar violaciones reales de ruido. */
  judgment: string;
}

const policySchema = z.strictObject({
  id: z.string().min(1), version: z.union([z.string().min(1), z.number().int().positive()]).default(1).transform(String),
  name: z.string().optional(), description: z.string().default(''), severity: z.enum(SEVERITIES),
  candidate_detectors: z.array(z.union([z.string().min(1), z.strictObject({
    name: z.string().min(1), params: z.record(z.string(), z.unknown()).optional(),
  })])).min(1),
  required_evidence: z.array(z.enum(EVIDENCE_REQUIREMENTS)).min(1).default(['location']),
  llm_judgment: z.strictObject({ question: z.string().min(1) }).optional(),
});

export function parsePolicy(yamlSource: string, sourcePath: string): Policy {
  const document = parseDocument(yamlSource, { uniqueKeys: true });
  if (document.errors.length) { throw new Error(`Policy inválida en ${sourcePath}: ${document.errors[0]!.message}`); }
  const raw = policySchema.parse(document.toJS({ maxAliasCount: 50 }));
  return {
    id: raw.id,
    version: raw.version,
    name: raw.name ?? raw.id,
    description: raw.description ?? '',
    severity: raw.severity,
    requiredEvidence: raw.required_evidence,
    detectors: raw.candidate_detectors.map((entry) =>
      typeof entry === 'string' ? { name: entry } : { name: entry.name, params: entry.params },
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
  const ids = policies.map((policy) => policy.id);
  if (new Set(ids).size !== ids.length) { throw new Error('Duplicate policy IDs in policy directory.'); }
  return policies.sort((left, right) => left.id.localeCompare(right.id));
}
