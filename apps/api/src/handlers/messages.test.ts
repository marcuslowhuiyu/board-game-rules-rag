import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { ModelCallRecord } from '@bgr/ai';
import {
  DailyLimitReachedError,
  ModelUnavailableError,
  RetrievalUnavailableError,
} from '@bgr/answering';
import {
  asContentId,
  asEditionId,
  asGameId,
  asSessionId,
  asSourceDocumentId,
  type Confidence,
  type RulesAnswer,
  type Message,
  type SourceDocument,
} from '@bgr/domain';
import { MessageIndexTakenError, type MessagesRepository } from '@bgr/persistence';
import type { RetrievedChunk } from '@bgr/retrieval';
import type { AnswerRun } from '../lib/answer-pipeline.js';
import { makeHandler } from '../lib/router.js';
import {
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

const call = (role: ModelCallRecord['role']): ModelCallRecord => ({
  role,
  modelKey: `${role}-model`,
  modelId: `${role}.model-id`,
  promptVersion: `${role}-vT`,
  inputTokens: 1,
  cacheReadInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 1,
  latencyMs: 1,
  costUsd: 0.001,
  attempts: 1,
  ok: true,
});

const record = call('router');

const outcome: AnswerRun = {
  documents: new Map([
    ['doc_1', doc('doc_1', 'Core Rulebook')],
    ['doc_2', doc('doc_2', 'FAQ')],
  ]),
  answer,
  // ch3 is retrieved but never cited, so it must not appear in citations.
  passages: [chunk('ch1', 'doc_1', 3), chunk('ch2', 'doc_2', 7), chunk('ch3', 'doc_1', 9)],
  tier: 'simple',
  calls: [call('router'), call('reranker'), call('answerer')],
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

let writes: MockInstance<typeof process.stdout.write>;
const logged = () => writes.mock.calls.map((c) => String(c[0]));
beforeEach(() => {
  writes = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});
afterEach(() => writes.mockRestore());

describe('POST /sessions/{sessionId}/messages', () => {
  it('returns the answer with citations resolved from the retrieved passages and documents', async () => {
    const pipeline = makeFakePipeline(outcome);
    const { handler } = await build(pipeline);
    const res = await ask(handler, { question: '  May I attack twice?  ' });

    expect(res.statusCode).toBe(200);
    const body = bodyAs<MessageResponse>(res);
    expect(body.messageId).toBe('m_2');
    expect(body.answer).toEqual(answer);
    expect(body.models).toEqual({
      router: { key: 'router-model', modelId: 'router.model-id' },
      reranker: { key: 'reranker-model', modelId: 'reranker.model-id' },
      answerer: { key: 'answerer-model', modelId: 'answerer.model-id' },
    });
    expect(body.promptVersions).toEqual({
      router: 'router-vT',
      reranker: 'reranker-vT',
      answerer: 'answerer-vT',
    });
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

    const bodyModels = {
      router: { key: 'router-model', modelId: 'router.model-id' },
      reranker: { key: 'reranker-model', modelId: 'reranker.model-id' },
      answerer: { key: 'answerer-model', modelId: 'answerer.model-id' },
    };
    const stored = await ctx.messages.listMessages(asSessionId(SESSION));
    expect(stored.map((m) => [m.index, m.role, m.messageId])).toEqual([
      [0, 'USER', 'm_1'],
      [1, 'ASSISTANT', 'm_2'],
    ]);
    expect(stored[0]?.content).toBe('May I attack twice?');
    expect(stored[1]).toMatchObject({
      content: 'Yes, you may.',
      answer,
      models: bodyModels,
      promptVersions: { router: 'router-vT', reranker: 'reranker-vT', answerer: 'answerer-vT' },
    });

    await ask(handler, { question: 'And once more?' });
    const next = await ctx.messages.listMessages(asSessionId(SESSION));
    expect(next.map((m) => m.index)).toEqual([0, 1, 2, 3]);
  });

  it('logs every model call of the run', async () => {
    const { handler } = await build(makeFakePipeline(outcome, [record]));
    await ask(handler, { question: 'May I attack twice?' });
    expect(
      logged().some((l) => l.includes('"msg":"model call"') && l.includes('"costUsd":0.001')),
    ).toBe(true);
  });

  it('lists only the models that served the answer, none for a run without evidence', async () => {
    const noEvidence: AnswerRun = {
      ...outcome,
      answer: { ...answer, evidence: [], tiers: [] },
      passages: [],
      calls: [call('router'), { ...call('reranker'), ok: false }],
    };
    const { ctx, handler } = await build(makeFakePipeline(noEvidence));
    const res = await ask(handler, { question: 'May I attack twice?' });
    const body = bodyAs<MessageResponse>(res);
    expect(Object.keys(body.models)).toEqual(['router']);
    expect(Object.keys(body.promptVersions)).toEqual(['router']);
    expect(body.citations).toEqual([]);
    const stored = await ctx.messages.listMessages(asSessionId(SESSION));
    expect(Object.keys(stored[1]?.models ?? {})).toEqual(['router']);
  });

  it('returns 500, not 400, when the stored answer fails server-side validation', async () => {
    const bad: AnswerRun = { ...outcome, answer: { ...answer, certainty: 'NOPE' as never } };
    const { ctx, handler } = await build(makeFakePipeline(bad));
    const res = await ask(handler, { question: 'May I attack twice?' });
    expect(res.statusCode).toBe(500);
    expect((await ctx.messages.listMessages(asSessionId(SESSION))).map((m) => m.role)).toEqual([
      'USER',
    ]);
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

  it('maps RetrievalUnavailableError to a retryable 503 RETRIEVAL_UNAVAILABLE', async () => {
    const { ctx, handler } = await build(
      makeFakePipeline(new RetrievalUnavailableError(new Error('ThrottlingException'))),
    );
    const res = await ask(handler, { question: 'May I attack twice?' });
    expect(res.statusCode).toBe(503);
    expect(bodyAs(res)).toEqual({
      error: {
        code: 'RETRIEVAL_UNAVAILABLE',
        message: "Couldn't look up the rules right now. Please try again.",
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

  describe('concurrent questions in one session', () => {
    /** Like makeFakePipeline, but yields before answering so another request can interleave. */
    const yieldingPipeline = (): FakePipeline => {
      const calls: FakePipeline['calls'] = [];
      return {
        calls,
        async answer(input) {
          calls.push(input);
          await new Promise((resolve) => setTimeout(resolve, 0));
          return outcome;
        },
      };
    };

    it('stores all four messages at distinct indexes and overwrites none', async () => {
      const { ctx, handler } = await build(yieldingPipeline());
      const [first, second] = await Promise.all([
        ask(handler, { question: 'First question?' }),
        ask(handler, { question: 'Second question?' }),
      ]);
      expect([first.statusCode, second.statusCode]).toEqual([200, 200]);

      const stored = await ctx.messages.listMessages(asSessionId(SESSION));
      expect(stored.map((m) => m.index)).toEqual([0, 1, 2, 3]);
      expect(new Set(stored.map((m) => m.messageId)).size).toBe(4);
      expect(stored.filter((m) => m.role === 'USER').map((m) => m.content)).toEqual(
        expect.arrayContaining(['First question?', 'Second question?']),
      );
      const assistantIds = stored.filter((m) => m.role === 'ASSISTANT').map((m) => m.messageId);
      expect(assistantIds).toEqual(
        expect.arrayContaining([
          bodyAs<MessageResponse>(first).messageId,
          bodyAs<MessageResponse>(second).messageId,
        ]),
      );
    });

    /** Wraps the in-memory repo; `taken(message)` makes an append collide as if another request won. */
    const colliding = (
      inner: MessagesRepository,
      taken: (m: Message) => boolean,
    ): MessagesRepository & { appends: Message[]; consistentReads: number } => {
      const appends: Message[] = [];
      const repo = {
        appends,
        consistentReads: 0,
        async appendMessage(m: Message) {
          appends.push(m);
          if (taken(m)) throw new MessageIndexTakenError(m.sessionId, m.index);
          await inner.appendMessage(m);
        },
        async listMessages(...args: Parameters<MessagesRepository['listMessages']>) {
          if (args[1]?.consistentRead) repo.consistentReads += 1;
          return inner.listMessages(...args);
        },
      };
      return repo;
    };

    it('picks the next index from a consistent read', async () => {
      const { ctx, handler } = await build(makeFakePipeline(outcome));
      const repo = colliding(ctx.messages, () => false);
      ctx.messages = repo;
      await ask(handler, { question: 'May I attack twice?' });
      expect(repo.consistentReads).toBe(2);
    });

    it('retries a colliding USER append and succeeds once the index is free', async () => {
      const { ctx, handler } = await build(makeFakePipeline(outcome));
      let collisions = 2;
      const repo = colliding(ctx.messages, (m) => m.role === 'USER' && collisions-- > 0);
      ctx.messages = repo;
      const res = await ask(handler, { question: 'May I attack twice?' });
      expect(res.statusCode).toBe(200);
      expect(repo.appends.filter((m) => m.role === 'USER')).toHaveLength(3);
    });

    it('returns 409 CONFLICT without running the pipeline when the USER append keeps colliding', async () => {
      const pipeline = makeFakePipeline(outcome);
      const { ctx, handler } = await build(pipeline);
      const repo = colliding(ctx.messages, (m) => m.role === 'USER');
      ctx.messages = repo;
      const res = await ask(handler, { question: 'May I attack twice?' });
      expect(res.statusCode).toBe(409);
      expect(bodyAs<{ error: { code: string } }>(res).error.code).toBe('CONFLICT');
      expect(repo.appends).toHaveLength(3);
      expect(pipeline.calls).toHaveLength(0);
    });

    it('returns 500 and logs it when the ASSISTANT append keeps colliding', async () => {
      const { ctx, handler } = await build(makeFakePipeline(outcome));
      const repo = colliding(ctx.messages, (m) => m.role === 'ASSISTANT');
      ctx.messages = repo;
      const res = await ask(handler, { question: 'May I attack twice?' });
      expect(res.statusCode).toBe(500);
      expect(repo.appends.filter((m) => m.role === 'ASSISTANT')).toHaveLength(3);
      expect(logged().some((l) => l.includes('assistant message not stored'))).toBe(true);
      expect((await ctx.messages.listMessages(asSessionId(SESSION))).map((m) => m.role)).toEqual([
        'USER',
      ]);
    });
  });
});
