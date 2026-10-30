import { describe, expect, it, vi } from 'vitest';
import type { ModelCallRecord } from '@bgr/ai';
import { DailyLimitReachedError, ModelUnavailableError, type AnswerOutcome } from '@bgr/answering';
import {
  asContentId,
  asEditionId,
  asGameId,
  asSessionId,
  asSourceDocumentId,
  type Confidence,
  type RulesAnswer,
  type SourceDocument,
} from '@bgr/domain';
import type { RetrievedChunk } from '@bgr/retrieval';
import { makeHandler } from '../lib/router.js';
import {
  TEST_ANSWER_META,
  bodyAs,
  makeEvent,
  makeFakePipeline,
  makeTestContext,
  type FakePipeline,
} from '../test-support.js';
import { messageRoutes, type MessageResponse } from './messages.js';

// Future-dated so the in-memory session store's wall-clock expiry check passes.
const NOW = '2099-01-01T00:00:00.000Z';
const SESSION = 's_abc';

const doc = (id: string, title: string): SourceDocument => ({
  documentId: asSourceDocumentId(id),
  gameId: asGameId('g_1'),
  editionId: asEditionId('e_1'),
  contentId: asContentId('c_1'),
  title,
  sourceType: 'RULEBOOK',
  authority: 'OFFICIAL_RULES',
  origin: 'UPLOAD',
  contentHash: 'a'.repeat(64),
  rawObjectUri: `s3://bucket/raw/${id}.pdf`,
  chunkCount: 0,
  status: 'CURRENT',
  supersedes: [],
  knowledgeRevision: 1,
  provenance: [{ kind: 'UPLOADED_FILE', filename: `${id}.pdf` }],
  createdAt: NOW,
  updatedAt: NOW,
});

const chunk = (chunkId: string, documentId: string, page: number): RetrievedChunk => ({
  chunkId,
  documentId,
  gameId: 'g_1',
  editionId: 'e_1',
  contentId: 'c_1',
  authority: 'OFFICIAL_RULES',
  sourceType: 'RULEBOOK',
  headingPath: ['Combat', `Part ${page}`],
  pageStart: page,
  pageEnd: page + 1,
  text: `text of ${chunkId}`,
  score: 0.9,
});

const confidence: Confidence = { level: 'HIGH', reasons: ['DIRECTLY_STATED'] };
const answer: RulesAnswer = {
  certainty: 'DEFINITIVE',
  authority: 'OFFICIAL_RULES',
  answer: 'Yes, you may.',
  explanation: 'Because the rules say so.',
  evidence: [{ chunkId: 'ch1' }],
  needsResearch: false,
  confidence,
  appliedTier: 'OFFICIAL',
  tiers: [
    {
      tier: 'OFFICIAL',
      answer: 'Yes, you may.',
      certainty: 'DEFINITIVE',
      evidence: [{ chunkId: 'ch1' }, { chunkId: 'ch2' }],
      confidence,
    },
  ],
  sourcesDisagree: false,
  requiresPlayerChoice: false,
};

const outcome: AnswerOutcome = {
  answer,
  // ch3 is retrieved but never cited, so it must not appear in citations.
  passages: [chunk('ch1', 'doc_1', 3), chunk('ch2', 'doc_2', 7), chunk('ch3', 'doc_1', 9)],
  tier: 'simple',
  calls: [],
};

const record: ModelCallRecord = {
  role: 'router',
  modelKey: 'k',
  modelId: 'id',
  promptVersion: 'v',
  inputTokens: 1,
  cacheReadInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 1,
  latencyMs: 1,
  costUsd: 0.001,
  attempts: 1,
  ok: true,
};

async function build(pipeline: FakePipeline, opts: { seedSession?: boolean } = {}) {
  let n = 0;
  const ctx = makeTestContext({
    now: NOW,
    answerPipeline: pipeline,
    ids: { messageId: () => `m_${++n}` },
  });
  if (opts.seedSession ?? true) {
    await ctx.sessions.createSession({
      sessionId: asSessionId(SESSION),
      gameId: asGameId('g_1'),
      editionId: asEditionId('e_1'),
      enabledContentIds: [asContentId('c_1')],
      configurationFingerprint: 'f'.repeat(64),
      createdAt: NOW,
      updatedAt: NOW,
      expiresAt: '2099-01-02T00:00:00.000Z',
      ttl: 4_070_995_200,
    });
  }
  await ctx.documents.createDocument(doc('doc_1', 'Core Rulebook'));
  await ctx.documents.createDocument(doc('doc_2', 'FAQ'));
  return { ctx, handler: makeHandler(messageRoutes(() => ctx)) };
}

const ask = (handler: Awaited<ReturnType<typeof build>>['handler'], body: unknown, id = SESSION) =>
  handler(
    makeEvent({
      rawPath: `/sessions/${id}/messages`,
      requestContext: { http: { method: 'POST' } } as never,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );

describe('POST /sessions/{sessionId}/messages', () => {
  it('returns the answer with citations resolved from the retrieved passages and documents', async () => {
    const pipeline = makeFakePipeline(outcome);
    const { handler } = await build(pipeline);
    const res = await ask(handler, { question: '  May I attack twice?  ' });

    expect(res.statusCode).toBe(200);
    const body = bodyAs<MessageResponse>(res);
    expect(body.messageId).toBe('m_2');
    expect(body.answer).toEqual(answer);
    expect(body.models).toEqual(TEST_ANSWER_META.models);
    expect(body.promptVersions).toEqual(TEST_ANSWER_META.promptVersions);
    expect(body.citations).toEqual([
      {
        chunkId: 'ch1',
        documentId: 'doc_1',
        title: 'Core Rulebook',
        sourceType: 'RULEBOOK',
        authority: 'OFFICIAL_RULES',
        pageStart: 3,
        pageEnd: 4,
        headingPath: ['Combat', 'Part 3'],
        text: 'text of ch1',
        provenance: [{ kind: 'UPLOADED_FILE', filename: 'doc_1.pdf' }],
      },
      {
        chunkId: 'ch2',
        documentId: 'doc_2',
        title: 'FAQ',
        sourceType: 'RULEBOOK',
        authority: 'OFFICIAL_RULES',
        pageStart: 7,
        pageEnd: 8,
        headingPath: ['Combat', 'Part 7'],
        text: 'text of ch2',
        provenance: [{ kind: 'UPLOADED_FILE', filename: 'doc_2.pdf' }],
      },
    ]);
    // The pipeline got the trimmed question and the session's configuration.
    expect(pipeline.calls[0]).toMatchObject({
      query: {
        text: 'May I attack twice?',
        gameId: 'g_1',
        editionId: 'e_1',
        enabledContentIds: ['c_1'],
      },
      correlationId: 'req-1',
    });
  });

  it('stores the USER message then the ASSISTANT message with indexes 0 and 1', async () => {
    const { ctx, handler } = await build(makeFakePipeline(outcome));
    await ask(handler, { question: 'May I attack twice?' });

    const stored = await ctx.messages.listMessages(asSessionId(SESSION));
    expect(stored.map((m) => [m.index, m.role, m.messageId])).toEqual([
      [0, 'USER', 'm_1'],
      [1, 'ASSISTANT', 'm_2'],
    ]);
    expect(stored[0]?.content).toBe('May I attack twice?');
    expect(stored[1]).toMatchObject({
      content: 'Yes, you may.',
      answer,
      models: TEST_ANSWER_META.models,
      promptVersions: TEST_ANSWER_META.promptVersions,
    });

    await ask(handler, { question: 'And once more?' });
    const next = await ctx.messages.listMessages(asSessionId(SESSION));
    expect(next.map((m) => m.index)).toEqual([0, 1, 2, 3]);
  });

  it('logs every model call of the run', async () => {
    const info = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const { handler } = await build(makeFakePipeline(outcome, [record]));
      await ask(handler, { question: 'May I attack twice?' });
      const lines = info.mock.calls.map((c) => String(c[0]));
      expect(
        lines.some((l) => l.includes('"msg":"model call"') && l.includes('"costUsd":0.001')),
      ).toBe(true);
    } finally {
      info.mockRestore();
    }
  });

  it('404s an unknown session without running the pipeline', async () => {
    const pipeline = makeFakePipeline(outcome);
    const { ctx, handler } = await build(pipeline, { seedSession: false });
    const res = await ask(handler, { question: 'May I attack twice?' });
    expect(res.statusCode).toBe(404);
    expect(pipeline.calls).toHaveLength(0);
    expect(await ctx.messages.listMessages(asSessionId(SESSION))).toEqual([]);
  });

  it.each([
    ['an empty question', { question: '' }],
    ['a blank question', { question: '   ' }],
    ['a 1001-character question', { question: 'x'.repeat(1001) }],
    ['a missing question', {}],
    ['a non-string question', { question: 42 }],
    ['malformed JSON', '{not json'],
  ])('400s %s without running the pipeline or storing anything', async (_name, body) => {
    const pipeline = makeFakePipeline(outcome);
    const { ctx, handler } = await build(pipeline);
    const res = await ask(handler, body);
    expect(res.statusCode).toBe(400);
    expect(pipeline.calls).toHaveLength(0);
    expect(await ctx.messages.listMessages(asSessionId(SESSION))).toEqual([]);
  });

  it('accepts a 1000-character question', async () => {
    const { handler } = await build(makeFakePipeline(outcome));
    expect((await ask(handler, { question: 'x'.repeat(1000) })).statusCode).toBe(200);
  });

  it('maps DailyLimitReachedError to 429 DAILY_LIMIT_REACHED', async () => {
    const { handler } = await build(makeFakePipeline(new DailyLimitReachedError()));
    const res = await ask(handler, { question: 'May I attack twice?' });
    expect(res.statusCode).toBe(429);
    expect(bodyAs(res)).toEqual({
      error: {
        code: 'DAILY_LIMIT_REACHED',
        message: 'The daily question limit has been reached. Try again tomorrow.',
      },
    });
  });

  it('maps ModelUnavailableError to 503 and keeps the USER message but stores no ASSISTANT message', async () => {
    const { ctx, handler } = await build(
      makeFakePipeline(new ModelUnavailableError(new Error('throttled'))),
    );
    const res = await ask(handler, { question: 'May I attack twice?' });
    expect(res.statusCode).toBe(503);
    expect(bodyAs(res)).toEqual({
      error: {
        code: 'MODEL_UNAVAILABLE',
        message: "Couldn't answer right now. Please try again.",
      },
    });
    const stored = await ctx.messages.listMessages(asSessionId(SESSION));
    expect(stored.map((m) => m.role)).toEqual(['USER']);
  });

  it('lets any other pipeline failure surface as a 500, never an answer', async () => {
    const { ctx, handler } = await build(makeFakePipeline(new Error('corrupt spend item')));
    const res = await ask(handler, { question: 'May I attack twice?' });
    expect(res.statusCode).toBe(500);
    const stored = await ctx.messages.listMessages(asSessionId(SESSION));
    expect(stored.map((m) => m.role)).toEqual(['USER']);
  });
});
