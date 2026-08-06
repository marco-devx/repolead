import { randomUUID } from 'node:crypto';

import type { Finding } from '@repolead/domain';
import type { KnowledgeStore } from '@repolead/knowledge-store';
import type { TechLeadModel } from '@repolead/lead-analyzer';

import type { Candidate } from './detectors';
import { DETECTORS } from './detectors';
import type { Policy } from './policy';

const JUDGE_SYSTEM = `You are a pragmatic software architect reviewing candidate policy violations detected by static analysis.
Your job is to separate real violations from harmless implementation details or false positives.
Judge each candidate strictly on the evidence provided. Be skeptical: confirm only what the evidence supports.`;

const VERDICTS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          confirmed: { type: 'boolean' },
          confidence: { type: 'number' },
          reasoning: { type: 'string' },
        },
        required: ['index', 'confirmed', 'confidence', 'reasoning'],
        additionalProperties: false,
      },
    },
  },
  required: ['verdicts'],
  additionalProperties: false,
};

interface Verdict {
  index: number;
  confirmed: boolean;
  confidence: number;
  reasoning: string;
}

export interface PolicyRunResult {
  candidates: number;
  confirmed: Finding[];
  rejected: number;
  judged: boolean;
}

export interface RunPoliciesOptions {
  store: KnowledgeStore;
  snapshotId: string;
  policies: Policy[];
  /** Sin modelo, los candidatos se guardan como status 'candidate' sin juicio. */
  model?: TechLeadModel | null;
}

function persistFinding(
  store: KnowledgeStore,
  snapshotId: string,
  policy: Policy,
  candidate: Candidate,
  status: Finding['status'],
  confidence: number,
): Finding {
  const snapshot = store.getLatestSnapshot();
  const finding: Finding = {
    id: `finding_${randomUUID()}`,
    snapshotId,
    repositoryId: snapshot?.repositoryId ?? 'unknown',
    ruleId: policy.id,
    severity: policy.severity,
    confidence,
    claim: candidate.claim,
    recommendation: null,
    module: candidate.module,
    status,
    supersededBy: null,
    createdAt: new Date().toISOString(),
  };
  store.insertFinding(
    finding,
    candidate.evidence.map((evidence) => ({
      id: `evidence_${randomUUID()}`,
      ownerId: finding.id,
      ownerKind: 'finding',
      path: evidence.path,
      startLine: evidence.startLine,
      endLine: evidence.endLine,
      excerpt: evidence.excerpt,
    })),
  );
  return finding;
}

/**
 * Pipeline de la Fase 6: detectores determinísticos generan candidatos y
 * Claude decide cuáles son violaciones reales. Un finding sin evidencia no
 * se guarda; un candidato rechazado por el juez tampoco.
 */
export async function runPolicies(options: RunPoliciesOptions): Promise<PolicyRunResult> {
  const { store, snapshotId, policies, model } = options;
  const result: PolicyRunResult = { candidates: 0, confirmed: [], rejected: 0, judged: Boolean(model) };

  for (const policy of policies) {
    const candidates: Candidate[] = [];
    for (const detectorRef of policy.detectors) {
      const detector = DETECTORS[detectorRef.name];
      if (!detector) {
        throw new Error(`Detector desconocido en ${policy.id}: ${detectorRef.name}`);
      }
      candidates.push(
        ...detector(store, snapshotId, detectorRef.params ?? {}).filter(
          (candidate) => candidate.evidence.length > 0,
        ),
      );
    }
    result.candidates += candidates.length;
    if (candidates.length === 0) {
      continue;
    }

    if (!model) {
      for (const candidate of candidates) {
        result.confirmed.push(persistFinding(store, snapshotId, policy, candidate, 'candidate', 0.5));
      }
      continue;
    }

    const prompt = `Policy: ${policy.name} (${policy.id}, severity ${policy.severity})
${policy.description}

Judgment question for each candidate:
${policy.judgment}

Candidates (JSON):
${JSON.stringify(candidates.map((candidate, index) => ({ index, claim: candidate.claim, evidence: candidate.evidence })))}

Return a verdict for every candidate index.`;

    const completion = await model.complete({ system: JUDGE_SYSTEM, prompt, schema: VERDICTS_SCHEMA });
    const verdicts = (completion.json as { verdicts: Verdict[] }).verdicts;

    for (const verdict of verdicts) {
      const candidate = candidates[verdict.index];
      if (!candidate) {
        continue;
      }
      if (verdict.confirmed) {
        result.confirmed.push(
          persistFinding(store, snapshotId, policy, candidate, 'confirmed', verdict.confidence),
        );
      } else {
        result.rejected += 1;
      }
    }
  }

  return result;
}
