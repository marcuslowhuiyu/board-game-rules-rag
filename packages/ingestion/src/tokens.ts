/**
 * Approximate token count. We use a fast heuristic (~4 characters per token
 * for English rulebook prose) — chunk sizes are budgetary, not billable, so
 * a real tokenizer isn't warranted at ingestion time. Downstream token
 * accounting (M4+) uses the model provider's actual counter.
 */
export function approxTokenCount(text: string): number {
  const chars = text.length;
  if (chars === 0) return 0;
  return Math.max(1, Math.ceil(chars / 4));
}
