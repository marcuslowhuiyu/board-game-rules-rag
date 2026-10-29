import type { QuestionTier } from '@bgr/ai';
import type { RouteOutcome } from '@bgr/retrieval';

export interface RoutingResult {
  cases: number;
  correct: number;
  accuracy: number;
  /** confusion[expected][predicted] */
  confusion: Record<QuestionTier, Record<QuestionTier, number>>;
  /** Router failures, which default to 'complex'. */
  fallbacks: number;
  /** Router failures grouped by error name. */
  fallbackReasons: Record<string, number>;
}

/** Error name from a "Name: message" string; 'unknown' when absent. */
export const reasonOf = (error: string | undefined): string =>
  error === undefined ? 'unknown' : error.split(':')[0]?.trim() || 'unknown';

/** Router accuracy against the labelled tiers. Reported, not gated. */
export function scoreRouting(
  expected: readonly QuestionTier[],
  predicted: readonly RouteOutcome[],
): RoutingResult {
  if (expected.length !== predicted.length) {
    throw new Error(`length mismatch: ${expected.length} expected, ${predicted.length} predicted`);
  }
  const confusion: RoutingResult['confusion'] = {
    simple: { simple: 0, complex: 0 },
    complex: { simple: 0, complex: 0 },
  };
  let correct = 0;
  for (const [i, want] of expected.entries()) {
    const got = predicted[i]!.tier;
    confusion[want][got] += 1;
    if (got === want) correct += 1;
  }
  const fallbackReasons: Record<string, number> = {};
  for (const p of predicted) {
    if (p.fallback) {
      const reason = reasonOf(p.error);
      fallbackReasons[reason] = (fallbackReasons[reason] ?? 0) + 1;
    }
  }
  return {
    cases: expected.length,
    correct,
    accuracy: expected.length === 0 ? 0 : correct / expected.length,
    confusion,
    fallbacks: predicted.filter((p) => p.fallback).length,
    fallbackReasons,
  };
}
