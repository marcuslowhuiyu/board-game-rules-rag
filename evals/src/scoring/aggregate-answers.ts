import { CONFIDENCE_LEVELS, type ConfidenceLevel } from '@bgr/domain';
import { z } from 'zod';
import type { AnswerCaseScore } from './score-answer.js';

export const AnswerBarsSchema = z.object({
  /** Most DEFINITIVE/QUALIFIED rulings allowed on not-in-rulebook cases. */
  maxGuesses: z.number().int().nonnegative(),
  /** Most answers allowed to state a forbidden claim (a wrong ruling). */
  maxForbiddenHits: z.number().int().nonnegative(),
  minEvidenceRate: z.number().min(0).max(1),
  minCertaintyRate: z.number().min(0).max(1),
});
export type AnswerBars = z.infer<typeof AnswerBarsSchema>;

export interface CalibrationBand {
  cases: number;
  right: number;
  rate: number | null;
}

export interface AnswerSummary {
  cases: number;
  errors: number;
  guesses: number;
  /** Answers that state a forbidden claim. */
  forbiddenHits: number;
  /** Over answerable cases, errors included. */
  evidenceRate: number;
  /** Over all cases, errors included. */
  certaintyRate: number;
  /** Over cases that set an expected authority; null when none do. */
  authorityRate: number | null;
  calibration: Record<ConfidenceLevel, CalibrationBand>;
  calibrationMonotonic: boolean;
  misroutes: {
    complexAsSimple: { cases: number; evidenceRate: number };
    simpleAsComplex: { cases: number };
  };
  verdict: 'pass' | 'fail' | 'incomplete';
}

const ratio = (n: number, d: number) => (d === 0 ? 0 : n / d);
// Tolerance so 17/20 meets a 0.85 bar despite float error.
const EPS = 1e-9;

export function aggregateAnswers(
  scores: readonly AnswerCaseScore[],
  bars: AnswerBars,
  opts: { cutShort: boolean },
): AnswerSummary {
  const answerable = scores.filter((s) => s.kind === 'answerable');
  const evidenceRate = ratio(
    answerable.filter((s) => s.evidenceOk === true).length,
    answerable.length,
  );
  const certaintyRate = ratio(scores.filter((s) => s.certaintyOk).length, scores.length);
  const guesses = scores.filter((s) => s.guess).length;
  const forbiddenHits = scores.filter((s) => s.forbiddenHit !== null).length;

  const withAuthority = scores.filter((s) => s.authorityOk !== null);
  const authorityRate =
    withAuthority.length === 0
      ? null
      : withAuthority.filter((s) => s.authorityOk === true).length / withAuthority.length;

  const isRight = (s: AnswerCaseScore) =>
    s.certaintyOk && s.evidenceOk !== false && s.forbiddenHit === null;
  const calibration = Object.fromEntries(
    CONFIDENCE_LEVELS.map((level) => {
      const band = scores.filter((s) => s.confidence === level);
      const right = band.filter(isRight).length;
      return [
        level,
        { cases: band.length, right, rate: band.length === 0 ? null : right / band.length },
      ];
    }),
  ) as Record<ConfidenceLevel, CalibrationBand>;
  const rates = CONFIDENCE_LEVELS.map((l) => calibration[l].rate).filter(
    (r): r is number => r !== null,
  );
  const calibrationMonotonic = rates.every((r, i) => i === 0 || rates[i - 1]! >= r);

  const complexAsSimple = scores.filter(
    (s) => s.labelledTier === 'complex' && s.routedTier === 'simple',
  );
  const simpleAsComplex = scores.filter(
    (s) => s.labelledTier === 'simple' && s.routedTier === 'complex',
  );

  // An errored not-in-rulebook case never tested the zero-guess mark, so a run that otherwise
  // passes is incomplete rather than pass.
  const untestedNoGuess = scores.some((s) => s.kind === 'not-in-rulebook' && s.error !== undefined);
  const passes =
    guesses <= bars.maxGuesses &&
    forbiddenHits <= bars.maxForbiddenHits &&
    evidenceRate >= bars.minEvidenceRate - EPS &&
    certaintyRate >= bars.minCertaintyRate - EPS;

  return {
    cases: scores.length,
    errors: scores.filter((s) => s.error !== undefined).length,
    guesses,
    forbiddenHits,
    evidenceRate,
    certaintyRate,
    authorityRate,
    calibration,
    calibrationMonotonic,
    misroutes: {
      complexAsSimple: {
        cases: complexAsSimple.length,
        evidenceRate: ratio(
          complexAsSimple.filter((s) => s.evidenceOk === true).length,
          complexAsSimple.length,
        ),
      },
      simpleAsComplex: { cases: simpleAsComplex.length },
    },
    verdict: opts.cutShort || (passes && untestedNoGuess) ? 'incomplete' : passes ? 'pass' : 'fail',
  };
}
