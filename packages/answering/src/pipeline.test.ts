import {
  ModelCallError,
  ModelOutputError,
  type ModelAnswer,
  type ModelCallRecord,
  type PassageRanker,
  type QuestionClassifier,
  type QuestionTier,
  type RulesAnswerer,
} from '@bgr/ai';
import type { RetrievedChunk, RulesRetriever } from '@bgr/retrieval';
import { describe, expect, it, vi } from 'vitest';
import {
  DailyLimitReachedError,
  ModelUnavailableError,
  createAnswerPipeline,
  recordModelCall,
  type SourceRecord,
} from './pipeline.js';
import { singaporeDayKey, type SpendLedger } from './spend-ledger.js';

const rec = (role: ModelCallRecord['role'], costUsd: number): ModelCallRecord => ({
  role,
  modelKey: 'm',
  modelId: 'id',
  promptVersion: 'v',
  inputTokens: 0,
  cacheReadInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  latencyMs: 1,
  costUsd,
  attempts: 1,
  ok: true,
});

const chunk = (n: number): RetrievedChunk =>
  ({
    chunkId: `c${n}`,
    documentId: 'd',
    text: `text ${n}`,
    headingPath: ['H'],
    score: 1 - n / 100,
    authority: 'OFFICIAL_RULES',
    sourceType: 'RULEBOOK',
  }) as unknown as RetrievedChunk;
const chunks = Array.from({ length: 15 }, (_, i) => chunk(i));

const source = (c: RetrievedChunk): SourceRecord => ({
  chunkId: c.chunkId,
  authority: 'OFFICIAL_RULES',
  provenance: [],
  title: 'Rulebook',
  sourceType: 'RULEBOOK',
});

const MODEL: ModelAnswer = {
  appliedTier: 'OFFICIAL',
  certainty: 'DEFINITIVE',
  answer: 'Yes.',
  explanation: 'Stated.',
  evidence: ['P1'],
  tiers: [{ tier: 'OFFICIAL', answer: 'Yes.', certainty: 'DEFINITIVE', evidence: ['P1'] }],
  sourcesDisagree: false,
};

const NOW = new Date('2026-10-30T04:00:00Z');
const DAY = '2026-10-30';

function setup(
  opts: {
    tier?: QuestionTier;
    spent?: number;
    retrieved?: RetrievedChunk[];
    answererError?: Error;
  } = {},
) {
  const order: string[] = [];
  const classify = vi.fn(async () => {
    order.push('route');
    recordModelCall(rec('router', 0.001));
    return { tier: opts.tier ?? 'simple', record: rec('router', 0.001) };
  });
  const retrieve = vi.fn(async () => {
    order.push('retrieve');
    return opts.retrieved ?? chunks;
  });
  const rank = vi.fn(async () => {
    order.push('rerank');
    recordModelCall(rec('reranker', 0.002));
    return {
      orderedIds: [...chunks].reverse().map((c) => c.chunkId),
      record: rec('reranker', 0.002),
    };
  });
  const answer = vi.fn(async (_q: string, passages: readonly { id: string }[]) => {
    order.push('answer');
    recordModelCall(rec('answerer', 0.01));
    if (opts.answererError) throw opts.answererError;
    return {
      output: MODEL,
      labels: new Map(passages.map((p, i) => [`P${i + 1}`, p.id])),
      record: rec('answerer', 0.01),
    };
  });
  const ledger: SpendLedger = {
    spentUsd: vi.fn(async () => opts.spent ?? 0),
    add: vi.fn(async () => undefined),
  };
  const sources = vi.fn(async (cs: readonly RetrievedChunk[]) => {
    order.push('sources');
    return new Map(cs.map((c) => [c.chunkId, source(c)]));
  });
  const pipeline = createAnswerPipeline({
    classifier: { classify } as unknown as QuestionClassifier,
    retriever: { retrieve } as RulesRetriever,
    ranker: { rank } as unknown as PassageRanker,
    answerer: { answer } as unknown as RulesAnswerer,
    sources,
    ledger,
    dailyCapUsd: 1,
    limits: { simple: 3, complex: 10 },
    now: () => NOW,
  });
  const seen: ModelCallRecord[] = [];
  const run = () =>
    pipeline.answer(
      {
        query: { text: 'q' } as never,
        correlationId: 'cid',
      },
      (r) => seen.push(r),
    );
  return { run, order, classify, retrieve, rank, answer, ledger, seen };
}

describe('answer pipeline', () => {
  it.each([
    ['simple', 3],
    ['complex', 10],
  ] as const)('runs the stages in order and keeps %s -> %i passages', async (tier, n) => {
    const t = setup({ tier });
    const out = await t.run();
    expect(t.order).toEqual(['route', 'retrieve', 'rerank', 'sources', 'answer']);
    expect(out.tier).toBe(tier);
    expect(out.passages).toHaveLength(n);
    // reranker reversed the order, so the kept passages are the last ones
    expect(out.passages[0]?.chunkId).toBe('c14');
    expect(t.answer.mock.calls[0]?.[1]).toHaveLength(n);
    expect(out.answer.certainty).toBe('DEFINITIVE');
    expect(out.answer.evidence).toEqual([{ chunkId: 'c14' }]);
    expect(out.calls.map((c) => c.role)).toEqual(['router', 'reranker', 'answerer']);
    expect(t.seen).toEqual(out.calls);
    expect(t.ledger.add).toHaveBeenCalledTimes(1);
    const [day, usd] = vi.mocked(t.ledger.add).mock.calls[0] ?? [];
    expect(day).toBe(DAY);
    expect(usd).toBeCloseTo(0.013);
  });

  it('throws DailyLimitReachedError at the cap and calls no model', async () => {
    const t = setup({ spent: 1 });
    await expect(t.run()).rejects.toBeInstanceOf(DailyLimitReachedError);
    expect(t.classify).not.toHaveBeenCalled();
    expect(t.retrieve).not.toHaveBeenCalled();
    expect(t.rank).not.toHaveBeenCalled();
    expect(t.answer).not.toHaveBeenCalled();
    expect(t.ledger.add).not.toHaveBeenCalled();
  });

  it('turns a ModelCallError into ModelUnavailableError and still records the spend', async () => {
    const cause = new ModelCallError('boom', rec('answerer', 0), new Error('x'));
    const t = setup({ answererError: cause });
    const err = await t.run().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelUnavailableError);
    expect((err as ModelUnavailableError).cause).toBe(cause);
    const [day, usd] = vi.mocked(t.ledger.add).mock.calls[0] ?? [];
    expect(day).toBe(DAY);
    expect(usd).toBeCloseTo(0.013);
  });

  it('turns a ModelOutputError into INCONCLUSIVE and records its cost', async () => {
    const t = setup({ answererError: new ModelOutputError('bad json', rec('answerer', 0)) });
    const out = await t.run();
    expect(out.answer.certainty).toBe('INCONCLUSIVE');
    expect(out.answer.evidence).toEqual([]);
    expect(vi.mocked(t.ledger.add).mock.calls[0]?.[1]).toBeCloseTo(0.013);
  });

  it('is INCONCLUSIVE without calling the answerer when no passages are found', async () => {
    const t = setup({ retrieved: [] });
    const out = await t.run();
    expect(out.answer.certainty).toBe('INCONCLUSIVE');
    expect(out.answer.explanation).toBe('No rules passages were found for this question.');
    expect(out.passages).toEqual([]);
    expect(t.answer).not.toHaveBeenCalled();
  });

  it('does not add to the ledger when nothing was spent', async () => {
    const t = setup({ retrieved: [] });
    t.classify.mockImplementation(async () => ({ tier: 'simple', record: rec('router', 0) }));
    t.rank.mockImplementation(async () => ({ orderedIds: [], record: rec('reranker', 0) }));
    await t.run();
    expect(t.ledger.add).not.toHaveBeenCalled();
  });
});

describe('singaporeDayKey', () => {
  it('uses the Singapore calendar day', () => {
    expect(singaporeDayKey(new Date('2026-10-30T16:30:00Z'))).toBe('2026-10-31');
    expect(singaporeDayKey(new Date('2026-10-30T15:59:00Z'))).toBe('2026-10-30');
  });
});
