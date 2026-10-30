import type { QuestionClassifier, QuestionTier } from '@bgr/ai';
import type { Logger } from '@bgr/shared';

/** Passages to keep per tier (config: 3 simple, 10 complex). */
export interface EvidenceLimits {
  simple: number;
  complex: number;
}

export function evidenceLimit(tier: QuestionTier, limits: EvidenceLimits): number {
  return limits[tier];
}

export interface RouteOutcome {
  tier: QuestionTier;
  /** True when the classifier failed and the tier defaulted to 'complex'. */
  fallback: boolean;
  /** Set when the classifier failed: the error name and message. */
  error?: string;
}

/** Router failure -> 'complex': keeping more evidence is the safe direction. Never throws. */
export async function routeQuestion(
  question: string,
  classifier: QuestionClassifier,
  options: { logger?: Logger; correlationId?: string } = {},
): Promise<RouteOutcome> {
  try {
    const { tier } = await classifier.classify(question, options.correlationId);
    return { tier, fallback: false };
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    options.logger?.warn('question router failed; treating question as complex', {
      correlationId: options.correlationId,
      error: message,
    });
    return { tier: 'complex', fallback: true, error: message };
  }
}
