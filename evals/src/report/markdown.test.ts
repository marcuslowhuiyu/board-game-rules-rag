import { describe, expect, it } from 'vitest';
import type { EvalReport } from '../scoring/aggregate.js';
import { toMarkdown } from './markdown.js';

const report: EvalReport = {
  generatedAt: '2026-10-27T00:00:00.000Z',
  config: {
    topK: 15,
    smallCorpusThreshold: 30,
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
      promptVersions: { reranker: 'reranker-v1' },
      modelCost: { usd: 0.0123, calls: 30, inputTokens: 1000, outputTokens: 200 },
      routing: {
        cases: 3,
        correct: 2,
        accuracy: 2 / 3,
        confusion: { simple: { simple: 1, complex: 0 }, complex: { simple: 1, complex: 1 } },
        fallbacks: 0,
      },
    });
    expect(md).toContain('Models: reranker nova-micro (apac.amazon.nova-micro-v1:0, reranker-v1)');
    expect(md).toContain('$0.0123 over 30 calls');
    expect(md).toContain('Rerank fallbacks: 2');
    expect(md).toContain('Cut short');
    expect(md).toContain('Routing accuracy: 67% (2/3');
    expect(md).toContain('| complex | 1 | 1 |');
  });
});
