import { describe, expect, it } from 'vitest';
import type { AnswerRunReport } from '../run-answer-eval.js';
import type { AnswerSummary } from '../scoring/aggregate-answers.js';
import { toAnswerMarkdown } from './answer-markdown.js';

const band = (cases: number, right: number) => ({
  cases,
  right,
  rate: cases === 0 ? null : right / cases,
});

function report(
  key: string,
  over: { verdict?: AnswerSummary['verdict']; perQuestionUsd?: number; cutShort?: boolean } = {},
): AnswerRunReport {
  const verdict = over.verdict ?? 'pass';
  return {
    generatedAt: '2026-10-31T00:00:00.000Z',
    labelledTier: false,
    bars: { maxGuesses: 0, minEvidenceRate: 0.85, minCertaintyRate: 0.75 },
    models: {
      router: { key: 'nova-micro', modelId: 'r' },
      reranker: { key: 'gpt-6-luna', modelId: 'k' },
      answerer: { key, modelId: `id-${key}` },
    },
    promptVersions: { router: 'router-v2', reranker: 'reranker-v2', answerer: 'answerer-v3' },
    cases: [
      {
        id: 'case-ok',
        kind: 'answerable',
        certaintyOk: true,
        guess: false,
        evidenceOk: true,
        authorityOk: true,
        forbiddenHit: null,
        disagreeOk: null,
        playerChoiceOk: null,
        confidence: 'HIGH',
        routedTier: 'simple',
        labelledTier: 'simple',
        latencyMs: 100,
        costUsd: 0.001,
      },
      {
        id: 'case-bad',
        kind: 'answerable',
        certaintyOk: false,
        guess: false,
        evidenceOk: false,
        authorityOk: null,
        forbiddenHit: 'keep both',
        disagreeOk: null,
        playerChoiceOk: null,
        confidence: 'LOW',
        routedTier: 'simple',
        labelledTier: 'complex',
        latencyMs: 300,
        costUsd: 0.001,
      },
    ],
    summary: {
      cases: 2,
      errors: 0,
      guesses: 0,
      evidenceRate: 0.9,
      certaintyRate: 0.8,
      authorityRate: null,
      calibration: { HIGH: band(1, 1), MEDIUM: band(0, 0), LOW: band(1, 0) },
      calibrationMonotonic: true,
      misroutes: {
        complexAsSimple: { cases: 1, evidenceRate: 0 },
        simpleAsComplex: { cases: 0 },
      },
      verdict,
    },
    cost: {
      usd: 0.002,
      calls: 6,
      perQuestionUsd: over.perQuestionUsd ?? 0.001,
      p50LatencyMs: 100,
      p95LatencyMs: 300,
    },
    cutShort: over.cutShort ?? verdict === 'incomplete',
  };
}

describe('toAnswerMarkdown', () => {
  it('markdown names the cheapest passing model', () => {
    const md = toAnswerMarkdown([
      report('sonnet', { perQuestionUsd: 0.01 }),
      report('haiku', { perQuestionUsd: 0.002 }),
      report('nova-lite', { perQuestionUsd: 0.0005, verdict: 'fail' }),
    ]);
    expect(md).toContain('| | sonnet | haiku | nova-lite |');
    expect(md).toMatch(/Cheapest model that clears every mark: \*\*haiku\*\*/);
    expect(md).not.toContain('none: operator decides');
  });

  it('markdown never names a model from an incomplete run', () => {
    const md = toAnswerMarkdown([
      report('cheap', { perQuestionUsd: 0.0001, verdict: 'incomplete' }),
      report('pricey', { perQuestionUsd: 0.01, verdict: 'fail' }),
    ]);
    expect(md).toContain('Cheapest model that clears every mark: none: operator decides');
    expect(md).toMatch(/incomplete/i);
    expect(md).toMatch(/cheap.*cut short/i);
  });

  it('a pass verdict on a cut-short run is still never named', () => {
    const md = toAnswerMarkdown([report('odd', { verdict: 'pass', cutShort: true })]);
    expect(md).toContain('none: operator decides');
  });

  it('shows the rows with their bars, — for empty buckets, and the failed cases', () => {
    const md = toAnswerMarkdown([report('haiku')]);
    expect(md).toContain('| guesses (bar 0) | 0 |');
    expect(md).toContain('| right passages (bar 85 %) | 90 % |');
    expect(md).toContain('| right certainty (bar 75 %) | 80 % |');
    expect(md).toContain('| authority | — |');
    expect(md).toContain('| errors | 0 |');
    expect(md).toContain('| calibration (H/M/L) | 100 % (1) / — / 0 % (1) |');
    expect(md).toContain('| misroutes | complex→simple 1 (evidence 0 %); simple→complex — |');
    expect(md).toContain('| $/question | $0.0010 |');
    expect(md).toContain('| p50/p95 latency | 100 / 300 ms |');
    expect(md).toContain('| verdict | pass |');
    expect(md).toMatch(
      /### Failed cases: haiku\n\n- case-bad: certainty, evidence, forbidden "keep both"/,
    );
    expect(md).not.toContain('case-ok:');
  });
});
