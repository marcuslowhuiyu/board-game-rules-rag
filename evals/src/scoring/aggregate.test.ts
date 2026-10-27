import { describe, expect, it } from 'vitest';
import { aggregate, type EvalConfig } from './aggregate.js';
import type { CaseResult } from './score-case.js';

const config: EvalConfig = {
  topK: 15,
  smallCorpusThreshold: 30,
  bars: { simple: { k: 3, minRate: 0.9 }, complex: { k: 10, minRate: 0.7 } },
};

function result(
  game: string,
  tier: 'simple' | 'complex',
  pass: boolean,
  over: Partial<CaseResult> = {},
): CaseResult {
  const k = { 1: pass, 3: pass, 5: pass, 10: pass };
  const r = pass ? 1 : 0;
  return {
    id: `${game}-${tier}-${Math.random().toString(36).slice(2, 8)}`,
    game,
    tier,
    retrieved: 15,
    itemRanks: {},
    recallAt: { 1: r, 3: r, 5: r, 10: r },
    fullCoverageAt: k,
    reciprocalRank: r,
    irrelevantTop5: 0.6,
    ...over,
  };
}

describe('aggregate', () => {
  it('tier pass rate excludes small-corpus games', () => {
    const results = [
      ...Array.from({ length: 5 }, () => result('tiny', 'simple', true)),
      result('big', 'simple', true),
      result('big', 'simple', false),
    ];
    const report = aggregate(results, { tiny: 7, big: 200 }, config);
    expect(report.tiers.simple.cases).toBe(2);
    expect(report.tiers.simple.passRate).toBe(0.5);
    expect(report.tiers.simple.passed).toBe(false);
    expect(report.games.find((g) => g.game === 'tiny')?.smallCorpus).toBe(true);
  });

  it('tier passed when rate meets bar exactly', () => {
    const results = [
      ...Array.from({ length: 9 }, () => result('big', 'simple', true)),
      result('big', 'simple', false),
    ];
    const report = aggregate(results, { big: 200 }, config);
    expect(report.tiers.simple.passRate).toBeCloseTo(0.9);
    expect(report.tiers.simple.passed).toBe(true);
  });

  it('judges complex cases on full coverage at the complex k', () => {
    const near = result('big', 'complex', false, {
      fullCoverageAt: { 1: false, 3: false, 5: false, 10: true },
    });
    const report = aggregate([near], { big: 200 }, config);
    expect(report.tiers.complex.passRate).toBe(1);
  });

  it('game row averages recall and MRR over that game cases', () => {
    const report = aggregate(
      [result('big', 'simple', true), result('big', 'simple', false, { retrieved: 0 })],
      { big: 200 },
      config,
    );
    const row = report.games[0]!;
    expect(row.cases).toBe(2);
    expect(row.recallAt3).toBe(0.5);
    expect(row.mrr).toBe(0.5);
    expect(row.emptyRetrievals).toBe(1);
    expect(row.simplePassRate).toBe(0.5);
    expect(row.complexFullCoverageRate).toBeNull();
  });

  it('a tier with no countable cases is not passed', () => {
    const report = aggregate([result('tiny', 'complex', true)], { tiny: 7 }, config);
    expect(report.tiers.complex.cases).toBe(0);
    expect(report.tiers.complex.passed).toBe(false);
  });
});

describe('loadEvalConfig', () => {
  it('loads the committed config with the spec bars', async () => {
    const { loadEvalConfig } = await import('./aggregate.js');
    const cfg = await loadEvalConfig(
      new URL('../../config/eval.config.json', import.meta.url).pathname,
    );
    expect(cfg).toEqual(config);
  });
});
