/** Cambiar la versión invalida la caché de todos los análisis previos. */
export const PROMPT_VERSION = '1';

export const TECH_LEAD_SYSTEM = `You are the Tech Lead of this codebase, performing a rigorous architectural analysis.

Rules:
- Base every conclusion EXCLUSIVELY on the evidence pack provided. Do not invent files, symbols or behaviors.
- Every claim in strengths, risks, opportunities, hotspots or technicalDebt MUST reference evidence: exact file paths or symbol qualified names taken verbatim from the pack.
- Be direct and specific. Prefer few well-founded findings over many speculative ones.
- If the evidence is insufficient for a section, return an empty array for it rather than speculating.`;

function claimWithEvidence(extra: Record<string, object> = {}): object {
  return {
    type: 'object',
    properties: {
      claim: { type: 'string' },
      evidence: { type: 'array', items: { type: 'string' } },
      ...extra,
    },
    required: ['claim', 'evidence', ...Object.keys(extra)],
    additionalProperties: false,
  };
}

export const MODULE_DOSSIER_SCHEMA = {
  type: 'object',
  properties: {
    responsibility: { type: 'string' },
    publicApi: { type: 'array', items: { type: 'string' } },
    dependencies: {
      type: 'object',
      properties: {
        incoming: { type: 'array', items: { type: 'string' } },
        outgoing: { type: 'array', items: { type: 'string' } },
      },
      required: ['incoming', 'outgoing'],
      additionalProperties: false,
    },
    mainFlows: { type: 'array', items: { type: 'string' } },
    strengths: { type: 'array', items: claimWithEvidence() },
    risks: {
      type: 'array',
      items: claimWithEvidence({
        severity: { type: 'string', enum: ['info', 'low', 'medium', 'high', 'critical'] },
      }),
    },
    opportunities: { type: 'array', items: claimWithEvidence() },
    testStrategy: { type: 'string' },
  },
  required: [
    'responsibility',
    'publicApi',
    'dependencies',
    'mainFlows',
    'strengths',
    'risks',
    'opportunities',
    'testStrategy',
  ],
  additionalProperties: false,
} as const;

export const REPOSITORY_BRIEF_SCHEMA = {
  type: 'object',
  properties: {
    objective: { type: 'string' },
    architecture: { type: 'string' },
    entryPoints: { type: 'array', items: { type: 'string' } },
    boundedContexts: { type: 'array', items: { type: 'string' } },
    criticalFlows: { type: 'array', items: { type: 'string' } },
    persistence: { type: 'string' },
    testing: { type: 'string' },
    hotspots: { type: 'array', items: claimWithEvidence() },
    technicalDebt: { type: 'array', items: claimWithEvidence() },
    conventions: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'objective',
    'architecture',
    'entryPoints',
    'boundedContexts',
    'criticalFlows',
    'persistence',
    'testing',
    'hotspots',
    'technicalDebt',
    'conventions',
  ],
  additionalProperties: false,
} as const;

export function modulePrompt(packJson: string): string {
  return `Analyze the following module using only this evidence pack.

Evidence pack:
${packJson}

Return the module dossier as JSON following the required schema.`;
}

export function repositoryPrompt(packJson: string): string {
  return `Synthesize the Repository Brief from the following evidence: repository stats and the dossiers of every module (already analyzed bottom-up).

Evidence pack:
${packJson}

Return the repository brief as JSON following the required schema.`;
}
