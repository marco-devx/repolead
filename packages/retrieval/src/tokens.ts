import { countTokens as countBpeTokens } from 'gpt-tokenizer/encoding/o200k_base';

/** A reproducible proxy, not a claim about a provider's billing tokenizer. */
export const TOKENIZER = 'o200k_base';

export function countTokens(text: string): number {
  return countBpeTokens(text, { disallowedSpecial: new Set() });
}

export function validateTokenBudget(value: number): number {
  if (!Number.isInteger(value) || value < 256 || value > 64_000) {
    throw new Error('El presupuesto debe ser un entero entre 256 y 64000 tokens.');
  }
  return value;
}
