import type { PassageRanker, QuestionClassifier, ModelCallRecord } from '@bgr/ai';
import type { RetrievedChunk, RulesRetriever } from '@bgr/retrieval';
import { describe, expect, it } from 'vitest';
import { CostMeter } from './cost-meter.js';
import type { RetrievalCase } from './dataset/case-schema.js';
import { runEval, type EvalGames } from './run-eval.js';
import type { EvalConfig } from './scoring/aggregate.js';

const config: EvalConfig = {
  topK: 15,
  rerankTopN: 2,
  smallCorpusThreshold: 0,
  bars: { simple: { k: 3, minRate: 0.9 }, complex: { k: 10, minRate: 0.7 } },
};
const games: EvalGames = {
  g: { gameId: 'g1', editionId: 'e1', content: { base: 'c1' }, chunks: 3 },
};
const chunk = (id: string, text: string, score: number): RetrievedChunk => ({
  chunkId: id,
  documentId: 'd',
  gameId: 'g1',
  editionId: 'e1',
  contentId: 'c1',
  authority: 'OFFICIAL_RULES',
  sourceType: 'RULEBOOK',
  headingPath: [],
  pageStart: 1,
  pageEnd: 1,
  text,
  score,
});
const retriever: RulesRetriever = {
  async retrieve() {
    return [
      chunk('a', 'alpha text', 0.9),
      chunk('b', 'beta text', 0.8),
      chunk('c', 'gamma text', 0.7),
    ];
  },
};
const mkCase = (id: string, tier: 'simple' | 'complex' = 'simple'): RetrievalCase => ({
  id,
  game: 'g',
  edition: 'base',
  enabledContent: ['base'],
  tier,
  question: 'q?',
  requiredEvidence: [{ key: `${id}/gamma`, phrase: 'gamma text', required: true }],
  source: { url: 'https://example.com', title: 't' },
});
const record = (role: 'router' | 'reranker', costUsd: number): ModelCallRecord => ({
  role,
  modelKey: 'k',
  modelId: 'm',
  promptVersion: 'v',
  inputTokens: 1,
  cacheReadInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 1,
  latencyMs: 1,
  costUsd,
  attempts: 1,
  ok: true,
});

function fakeRanker(meter: CostMeter, order: string[], fail: boolean | Error = false) {
  const ranker: PassageRanker & { calls: number } = {
    calls: 0,
    async rank() {
      ranker.calls++;
      meter.record(record('reranker', 0.1));
      if (fail) throw fail instanceof Error ? fail : new Error('boom');
      return { orderedIds: order, record: record('reranker', 0.1) };
    },
  };
  return ranker;
}

describe('runEval with models', () => {
  it('scores the reordered list from a reranker', async () => {
    const meter = new CostMeter(10);
    const ranker = fakeRanker(meter, ['c', 'a', 'b']);
    const report = await runEval({
      cases: [mkCase('one')],
      games,
      retriever,
      config,
      meter,
      ranker,
    });
    expect(report.cases[0]!.fullCoverageAt[1]).toBe(true);
    expect(report.cutShort).toBe(false);
    expect(report.rerankFallbacks).toBe(0);
  });

  it('without a reranker the retrieval order is scored', async () => {
    const report = await runEval({ cases: [mkCase('one')], games, retriever, config });
    expect(report.cases[0]!.fullCoverageAt[1]).toBe(false);
    expect(report.cutShort).toBe(false);
  });

  it('counts a failed reranker call as a fallback, still costing money', async () => {
    const meter = new CostMeter(10);
    const ranker = fakeRanker(meter, [], true);
    const report = await runEval({
      cases: [mkCase('one')],
      games,
      retriever,
      config,
      meter,
      ranker,
    });
    expect(report.rerankFallbacks).toBe(1);
    expect(meter.spentUsd).toBeCloseTo(0.1);
    // score order a, b, c: gamma is third
    expect(report.cases[0]!.itemRanks['one/gamma']).toBe(3);
  });

  it('stops reranking once the meter is exhausted and marks cutShort', async () => {
    const meter = new CostMeter(0);
    const ranker = fakeRanker(meter, ['c', 'a', 'b']);
    const report = await runEval({
      cases: [mkCase('one'), mkCase('two')],
      games,
      retriever,
      config,
      meter,
      ranker,
    });
    expect(ranker.calls).toBe(0);
    expect(report.cutShort).toBe(true);
    expect(report.cases).toHaveLength(2);
  });

  it('stops mid-run when the spend reaches the cap', async () => {
    const meter = new CostMeter(0.15);
    const ranker = fakeRanker(meter, ['c', 'a', 'b']);
    const report = await runEval({
      cases: [mkCase('one'), mkCase('two'), mkCase('three')],
      games,
      retriever,
      config,
      meter,
      ranker,
    });
    expect(ranker.calls).toBe(2);
    expect(report.cutShort).toBe(true);
  });

  it('reports routing against labelled tiers, using the labelled tier for scoring', async () => {
    const meter = new CostMeter(10);
    const classifier: QuestionClassifier = {
      async classify() {
        meter.record(record('router', 0.01));
        return { tier: 'simple', record: record('router', 0.01) };
      },
    };
    const report = await runEval({
      cases: [
        mkCase('one', 'simple'),
        {
          ...mkCase('two', 'complex'),
          requiredEvidence: [
            { key: 'two/a', phrase: 'alpha text', required: true },
            { key: 'two/b', phrase: 'beta text', required: true },
          ],
        },
      ],
      games,
      retriever,
      config,
      meter,
      classifier,
    });
    expect(report.routing?.cases).toBe(2);
    expect(report.routing?.correct).toBe(1);
    expect(report.routing?.confusion.complex.simple).toBe(1);
    expect(report.cases[1]!.tier).toBe('complex');
  });

  it('records per-case rerank state and summary totals', async () => {
    const meter = new CostMeter(10);
    const ranker = fakeRanker(meter, ['c']);
    const report = await runEval({
      cases: [mkCase('one')],
      games,
      retriever,
      config,
      meter,
      ranker,
    });
    expect(report.cases[0]).toMatchObject({
      rerank: 'reranked',
      rerankPlaced: 1,
      rerankCandidates: 3,
      routed: false,
    });
    expect(report).toMatchObject({
      rerankRequested: true,
      rerankedCases: 1,
      placedTotal: 1,
      expectedPlacements: 2, // min(rerankTopN 2, 3 candidates)
      candidatesTotal: 3,
      rerankFallbackReasons: {},
    });
  });

  it('records fallback reasons by error name and skipped cases after the cap', async () => {
    const meter = new CostMeter(0.15);
    const err = Object.assign(new Error('slow'), { name: 'ThrottlingException' });
    const ranker = fakeRanker(meter, [], err);
    const report = await runEval({
      cases: [mkCase('one'), mkCase('two'), mkCase('three')],
      games,
      retriever,
      config,
      meter,
      ranker,
    });
    expect(report.cases.map((c) => c.rerank)).toEqual(['fallback', 'fallback', 'skipped']);
    expect(report.cases[0]!.rerankError).toBe('ThrottlingException: slow');
    expect(report.rerankFallbackReasons).toEqual({ ThrottlingException: 2 });
    expect(report.rerankedCases).toBe(0);
    expect(report.cases[2]).toMatchObject({ rerankPlaced: 0, rerankCandidates: 0 });
  });

  it('marks cases skipped when no reranker was requested', async () => {
    const report = await runEval({ cases: [mkCase('one')], games, retriever, config });
    expect(report.cases[0]!.rerank).toBe('skipped');
    expect(report.rerankRequested).toBe(false);
  });

  it('records routed per case and router fallback reasons', async () => {
    const meter = new CostMeter(10);
    const classifier: QuestionClassifier = {
      async classify() {
        meter.record(record('router', 0.01));
        throw Object.assign(new Error('no'), { name: 'AccessDeniedException' });
      },
    };
    const report = await runEval({
      cases: [mkCase('one')],
      games,
      retriever,
      config,
      meter,
      classifier,
    });
    expect(report.cases[0]!.routed).toBe(true);
    expect(report.routing?.fallbacks).toBe(1);
    expect(report.routing?.fallbackReasons).toEqual({ AccessDeniedException: 1 });
  });
});
