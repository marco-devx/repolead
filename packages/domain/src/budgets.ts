/** Aggregate retrieved evidence, not a model's native context window. */
export const MAX_CONTEXT_TOKENS = 120_000;
export const DEFAULT_CONTEXT_TOKENS = 120_000;
/** Token fitting remains authoritative; do not stop large bodies at 1,200 lines. */
export const DEFAULT_SOURCE_LINES = 100_000;
export const DEFAULT_LOCAL_MODEL = 'qwen3.5:9b-q4_K_M';
