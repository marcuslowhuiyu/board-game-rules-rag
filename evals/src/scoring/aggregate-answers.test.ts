import { describe, expect, it } from 'vitest';
import { aggregateAnswers, type AnswerBars } from './aggregate-answers.js';
import type { AnswerCaseScore } from './score-answer.js';

const bars: AnswerBars = { maxGuesses: 0, minEvidenceRate: 0.85, minCertaintyRate: 0.75 };

const score = (over: Partial<AnswerCaseScore> = {}): AnswerCaseScore => ({
  id: Math.random().toString(36).slice(2),
  kind: 'answerable',
  certaintyOk: true,
  guess: false,
  evidenceOk: true,
  authorityOk: null,
  forbiddenHit: null,
  disagreeOk: null,
  playerChoiceOk: null,
  confidence: 'HIGH',
  routedTier: 'simple',
  labelledTier: 'simple',
  ...over,
});
const errored = (): AnswerCaseScore =>
  score({
    error: 'boom',
    certaintyOk: false,
    evidenceOk: false,
    confidence: null,
    routedTier: null,
  });
const many = (n: number, over: Partial<AnswerCaseScore> = {}) =>
  Array.from({ length: n }, () => score(over));

describe('aggregateAnswers', () => {
  it('passes when every mark holds', () => {
    const s = aggregateAnswers(many(4), bars, { cutShort: false });
    expect(s).toMatchObject({ cases: 4, errors: 0, guesses: 0, evidenceRate: 1, verdict: 'pass' });
  });

  it('errors count against rates', () => {
    const s = aggregateAnswers([...many(3), errored()], bars, { cutShort: false });
    expect(s.errors).toBe(1);
    expect(s.evidenceRate).toBeLessThanOrEqual(0.75);
    expect(s.certaintyRate).toBeLessThanOrEqual(0.75);
    expect(s.verdict).toBe('fail');
  });

  it('a guess fails the verdict', () => {
    const s = aggregateAnswers(
      [
        ...many(9),
        score({ kind: 'not-in-rulebook', guess: true, certaintyOk: false, evidenceOk: null }),
      ],
      bars,
      { cutShort: false },
    );
    expect(s.guesses).toBe(1);
    expect(s.verdict).toBe('fail');
  });

  it('cut-short report has no pass verdict', () => {
    expect(aggregateAnswers(many(4), bars, { cutShort: true }).verdict).toBe('incomplete');
  });

  it('calibration bands and monotonic flag', () => {
    const good = aggregateAnswers(
      [
        ...many(2, { confidence: 'HIGH' }),
        score({ confidence: 'MEDIUM' }),
        score({ confidence: 'MEDIUM', certaintyOk: false }),
        score({ confidence: 'LOW', certaintyOk: false }),
      ],
      bars,
      { cutShort: false },
    );
    expect(good.calibration.HIGH).toEqual({ cases: 2, right: 2, rate: 1 });
    expect(good.calibration.MEDIUM).toEqual({ cases: 2, right: 1, rate: 0.5 });
    expect(good.calibration.LOW).toEqual({ cases: 1, right: 0, rate: 0 });
    expect(good.calibrationMonotonic).toBe(true);
    const bad = aggregateAnswers(
      [score({ confidence: 'HIGH', certaintyOk: false }), score({ confidence: 'LOW' })],
      bars,
      { cutShort: false },
    );
    expect(bad.calibration.MEDIUM).toEqual({ cases: 0, right: 0, rate: null });
    expect(bad.calibrationMonotonic).toBe(false);
  });

  it('right excludes forbidden hits and missing evidence', () => {
    const s = aggregateAnswers(
      [score({ forbiddenHit: 'x' }), score({ evidenceOk: false }), score()],
      bars,
      { cutShort: false },
    );
    expect(s.calibration.HIGH).toEqual({ cases: 3, right: 1, rate: 1 / 3 });
  });

  it('authority rate covers only cases that set it', () => {
    expect(aggregateAnswers(many(2), bars, { cutShort: false }).authorityRate).toBeNull();
    const s = aggregateAnswers(
      [score({ authorityOk: true }), score({ authorityOk: false })],
      bars,
      {
        cutShort: false,
      },
    );
    expect(s.authorityRate).toBe(0.5);
  });

  it('misroute bucket collects complex cases routed simple', () => {
    const s = aggregateAnswers(
      [
        score({ labelledTier: 'complex', routedTier: 'simple', evidenceOk: false }),
        score({ labelledTier: 'complex', routedTier: 'simple', evidenceOk: true }),
        score({ labelledTier: 'simple', routedTier: 'complex' }),
        score({ labelledTier: 'complex', routedTier: 'complex' }),
      ],
      bars,
      { cutShort: false },
    );
    expect(s.misroutes).toEqual({
      complexAsSimple: { cases: 2, evidenceRate: 0.5 },
      simpleAsComplex: { cases: 1 },
    });
  });
});
