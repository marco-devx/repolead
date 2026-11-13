/** Allow functional prose, never arbitrary source/document JSON. Not a general DLP classifier. */
export function productProse(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > 6000) { return null; }
  if (/```|~~~|-----BEGIN|\bBearer\s+\S+|(?:password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*["']?\S+|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|gh[pousr]_[A-Za-z0-9]+|sk-[A-Za-z0-9_-]{16,}|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|(?:https?|postgres(?:ql)?|mysql|mongodb|redis):\/\/|\/(?:home|Users)\/|(?:^|\n)\s*(?:import |from \S+ import |(?:async )?def |class \w+[:({]|(?:export )?(?:const|let|var) \w+\s*=)/i.test(value)) { return null; }
  return value.trim();
}
