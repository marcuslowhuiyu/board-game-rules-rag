import { describe, expect, it } from 'vitest';
import type { EvalReport } from '../scoring/aggregate.js';
import { toMarkdown } from './markdown.js';

const report: EvalReport = {
  generatedAt: '2026-10-27T00:00:00.000Z',
  config: {
    topK: 15,
    smallCorpusThreshold: 30,
    rerankTopN: 10,
    bars: { simple: { k: 3, minRate: 0.9 }, complex: { k: 10, minRate: 0.7 } },
  },
  games: [
    {
      game: 'ticket-to-ride',
      chunks: 7,
      smallCorpus: true,
      cases: 2,
      emptyRetrievals: 0,
      recallAt1: 1,
      recallAt3: 1,
      recallAt5: 1,
      mrr: 1,
      irrelevantRate: 0.5,
      simplePassRate: 1,
      complexFullCoverageRate: null,
    },
  ],
  tiers: {
    simple: { cases: 10, passRate: 0.95, bar: 0.9, passed: true },
    complex: { cases: 5, passRate: 0.4, bar: 0.7, passed: false },
  },
  cutShort: false,
  rerankFallbacks: 0,
  rerankRequested: false,
  rerankedCases: 0,
  placedTotal: 0,
  expectedPlacements: 0,
  candidatesTotal: 0,
  rerankFallbackReasons: {},
  cases: [
    {
      id: 'seti-milestone-order',
      game: 'seti',
      tier: 'complex',
      retrieved: 15,
      itemRanks: {},
      recallAt: { 1: 0, 3: 0, 5: 0, 10: 0.5 },
      fullCoverageAt: { 1: false, 3: false, 5: false, 10: false },
      reciprocalRank: 0.2,
      irrelevantTop5: 1,
    },
  ],
};

describe('toMarkdown', () => {
  it('marks small-corpus rows and failed tiers', () => {
    const md = toMarkdown(report);
    expect(md).toContain('ticket-to-ride (small corpus)');
    expect(md).toMatch(/simple.*95%.*90%.*✅/);
    expect(md).toMatch(/complex.*40%.*70%.*❌/);
  });

  it('lists failed case ids per tier', () => {
    expect(toMarkdown(report)).toMatch(/Failed complex cases[^\n]*\n[^\n]*seti-milestone-order/);
  });

  it('names the index the run used in the heading', () => {
    expect(toMarkdown(report, 'local index, 512 dimensions')).toMatch(
      /^## Retrieval eval — local index, 512 dimensions — 2026-10-27T00:00:00.000Z\n/,
    );
  });

  it('reports models, cost, the cut-short warning and routing', () => {
    const md = toMarkdown({
      ...report,
      cutShort: true,
      rerankFallbacks: 2,
      models: { reranker: { key: 'nova-micro', modelId: 'apac.amazon.nova-micro-v1:0' } },
      promptVersions: { reranker: 'reranker-v2' },
      modelCost: {
        usd: 0.0123,
        calls: 30,
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadInputTokens: 300,
        cacheWriteInputTokens: 5000,
      },
      routing: {
        cases: 3,
        correct: 2,
        accuracy: 2 / 3,
        confusion: { simple: { simple: 1, complex: 0 }, complex: { simple: 1, complex: 1 } },
        fallbacks: 0,
        fallbackReasons: {},
      },
    });
    expect(md).toContain('Models: reranker nova-micro (apac.amazon.nova-micro-v1:0, reranker-v2)');
    expect(md).toContain(
      '$0.0123 over 30 calls (6300 input, 200 output tokens; input includes 300 cache read and 5000 cache write)',
    );
    expect(md).toContain('Rerank fallbacks: 2');
    expect(md).toContain('Cut short');
    expect(md).toContain('Routing accuracy: 67% (2/3');
    expect(md).toContain('| complex | 1 | 1 |');
  });

  it('prints reranker coverage and fallbacks by reason', () => {
    const md = toMarkdown({
      ...report,
      rerankRequested: true,
      rerankFallbacks: 3,
      rerankedCases: 7,
      placedTotal: 60,
      expectedPlacements: 70,
      candidatesTotal: 105,
      rerankFallbackReasons: { ThrottlingException: 2, ModelOutputError: 1 },
      cases: Array.from({ length: 10 }, (_, i) => ({
        ...report.cases[0]!,
        id: `c${i}`,
        rerank: (i < 7 ? 'reranked' : 'fallback') as 'reranked' | 'fallback',
      })),
    });
    expect(md).toContain(
      'Reranked 7 of 10 cases; model placed 60 of 70 requested (105 candidates); fallbacks by reason: ThrottlingException 2, ModelOutputError 1',
    );
  });

  it('says not a valid gate when a rerank run fell back, skipped or was cut short', () => {
    const rerankRun = {
      ...report,
      rerankRequested: true,
      cases: [{ ...report.cases[0]!, rerank: 'fallback' as const }],
    };
    const md = toMarkdown(rerankRun);
    expect(md).toMatch(/simple.*95%.*90%.*not a valid gate/);
    expect(md).not.toContain('✅');
    expect(md).not.toContain('❌');
    const cut = toMarkdown({ ...report, cutShort: true });
    expect(cut).toMatch(/complex.*40%.*70%.*not a valid gate/);
    const skipped = toMarkdown({
      ...rerankRun,
      cases: [{ ...report.cases[0]!, rerank: 'skipped' as const }],
    });
    expect(skipped).toContain('not a valid gate');
  });

  it('keeps the gate verdict when every case was reranked', () => {
    const md = toMarkdown({
      ...report,
      rerankRequested: true,
      cases: [{ ...report.cases[0]!, rerank: 'reranked' as const }],
    });
    expect(md).toContain('✅');
    expect(md).not.toContain('not a valid gate');
  });
});
