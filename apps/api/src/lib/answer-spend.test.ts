import { describe, expect, it, vi } from 'vitest';
import type { EmbeddingsProvider } from '@bgr/ai';
import { ModelUnavailableError, singaporeDayKey } from '@bgr/answering';
import {
  asContentId,
  asEditionId,
  asGameId,
  asSourceDocumentId,
  type SourceDocument,
} from '@bgr/domain';
import { InMemoryDocumentsRepository, InMemorySpendLedger } from '@bgr/persistence';
import type { VectorHit, VectorIndex } from '@bgr/retrieval';
import { createLogger } from '@bgr/shared';
import { buildAnswerPipeline, type AnsweringConfig } from './answer-pipeline.js';

const NOW = new Date('2026-10-30T10:00:00.000Z');
const TS = NOW.toISOString();

const CONFIG: AnsweringConfig = {
  usageTable: 'usage',
  dailyAiCapUsd: 1,
  modelRequestTimeoutMs: 20_000,
  evidenceLimits: { simple: 3, complex: 10 },
  rerankCandidates: 7,
  rerankTopN: 10,
  runBudgetMs: 26_000,
};

const doc = (id: string): SourceDocument => ({
  documentId: asSourceDocumentId(id),
  gameId: asGameId('g_1'),
  editionId: asEditionId('e_1'),
  contentId: asContentId('c_1'),
  title: `Title ${id}`,
  sourceType: 'RULEBOOK',
  authority: 'OFFICIAL_RULES',
  origin: 'UPLOAD',
  contentHash: 'a'.repeat(64),
  rawObjectUri: `s3://bucket/raw/${id}.pdf`,
  chunkCount: 0,
  status: 'CURRENT',
  supersedes: [],
  knowledgeRevision: 1,
  provenance: [],
  createdAt: TS,
  updatedAt: TS,
});

const hit = (key: string, documentId: string, score: number): VectorHit => ({
  key,
  score,
  metadata: {
    gameId: 'g_1',
    editionId: 'e_1',
    contentId: 'c_1',
    documentId,
    authority: 'OFFICIAL_RULES',
    sourceType: 'RULEBOOK',
    headingPath: ['Combat'],
    pageStart: 1,
    pageEnd: 1,
    text: `rule text ${key}`,
  },
});

/** Bedrock replies by role, recognised from each role's system prompt. */
function fakeBedrock() {
  const reply = (text: string, usage: Record<string, number>) => ({
    output: { message: { role: 'assistant', content: [{ text }] } },
    usage,
  });
  const modelAnswer = {
    appliedTier: 'OFFICIAL',
    certainty: 'DEFINITIVE',
    answer: 'Yes.',
    explanation: 'Rule 1 says so.',
    evidence: ['P1'],
    tiers: [{ tier: 'OFFICIAL', answer: 'Yes.', certainty: 'DEFINITIVE', evidence: ['P1'] }],
    sourcesDisagree: false,
  };
  return {
    async send(command: { input: { system?: Array<{ text?: string }> } }) {
      const system = command.input.system?.[0]?.text ?? '';
      if (system.startsWith('You classify questions')) {
        return reply('{"tier":"simple"}', { inputTokens: 200, outputTokens: 10 });
      }
      if (system.startsWith('You rank passages')) {
        return reply('{"order":["P2","P1","P3"]}', { inputTokens: 900, outputTokens: 20 });
      }
      if (system.startsWith('You answer questions')) {
        return reply(JSON.stringify(modelAnswer), {
          inputTokens: 700,
          outputTokens: 120,
          cacheReadInputTokens: 300,
          cacheWriteInputTokens: 400,
        });
      }
      throw new Error(`unexpected prompt: ${system.slice(0, 40)}`);
    },
  };
}

/** A Bedrock client that never answers, so only the request timeout ends a call. */
const hangingBedrock = () => ({
  send: (_command: unknown, options?: { abortSignal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      options?.abortSignal?.addEventListener('abort', () => reject(new Error('timed out')));
    }),
});

async function setup(config: Partial<AnsweringConfig> = {}, client: unknown = fakeBedrock()) {
  const repo = new InMemoryDocumentsRepository();
  for (const id of ['doc_1', 'doc_2']) await repo.createDocument(doc(id));
  // doc_2 is listed as current but its lookup finds nothing (removed since retrieval).
  const getDocument = vi.fn(async (id: Parameters<typeof repo.getDocument>[0]) =>
    id === 'doc_2' ? null : repo.getDocument(id),
  );
  const documents = {
    getDocument,
    listDocumentsForEdition: repo.listDocumentsForEdition.bind(repo),
  };

  const query = vi.fn(async () => [
    hit('ch1', 'doc_1', 0.9),
    hit('ch2', 'doc_1', 0.8),
    hit('ch3', 'doc_2', 0.7),
  ]);
  const index = { query } as unknown as VectorIndex;
  const embeddings: EmbeddingsProvider = {
    modelId: 'embed',
    dimensions: 1,
    embed: async () => ({ vectors: [[1]], inputTokens: 1 }),
  };
  const lines: string[] = [];
  const ledger = new InMemorySpendLedger();
  const pipeline = buildAnswerPipeline({
    config: { ...CONFIG, ...config },
    documents,
    ledger,
    embeddings,
    index,
    logger: createLogger({ sink: (l) => lines.push(l) }),
    clientFactory: () => client as never,
    now: () => NOW,
  });
  const run = (onCall: (r: { role: string }) => void = () => undefined) =>
    pipeline.answer(
      {
        query: {
          gameId: asGameId('g_1'),
          editionId: asEditionId('e_1'),
          enabledContentIds: [asContentId('c_1')],
          text: 'May I attack twice?',
        },
        correlationId: 'req-1',
      },
      onCall,
    );
  return { run, ledger, getDocument, query, lines };
}

describe('buildAnswerPipeline (the Lambda wiring), with fake Bedrock, vectors and documents', () => {
  it('records every model call in the ledger, cache tokens included', async () => {
    const { run, ledger } = await setup();
    const seen: string[] = [];
    const outcome = await run((r) => seen.push(r.role));

    expect(outcome.answer.certainty).toBe('DEFINITIVE');
    expect(seen).toEqual(['router', 'reranker', 'answerer']);
    expect(outcome.calls).toHaveLength(3);
    const total = outcome.calls.reduce((sum, c) => sum + c.costUsd, 0);
    expect(total).toBeGreaterThan(0);
    const answerer = outcome.calls.find((c) => c.role === 'answerer');
    expect(answerer?.cacheWriteInputTokens).toBe(400);
    expect(answerer?.costUsd).toBeCloseTo((700 * 0.1 + 120 * 0.5 + 300 * 0.1 + 400 * 0.1) / 1e6);
    expect(await ledger.spentUsd(singaporeDayKey(NOW))).toBeCloseTo(total, 12);
  });

  it('looks each document up once per run and drops, and logs, a chunk whose document is missing', async () => {
    const { run, getDocument, lines } = await setup();
    const outcome = await run();

    expect(getDocument.mock.calls.map((c) => c[0]).sort()).toEqual(['doc_1', 'doc_2']);
    expect([...outcome.documents.keys()]).toEqual(['doc_1']);
    expect(outcome.passages.map((p) => p.chunkId).sort()).toEqual(['ch1', 'ch2']);
    expect(
      lines.some(
        (l) =>
          l.includes('chunk dropped: its document is missing') && l.includes('"chunkId":"ch3"'),
      ),
    ).toBe(true);
  });

  it('queries the vector index for rerankCandidates hits', async () => {
    const { run, query } = await setup({ rerankCandidates: 7 });
    await run();
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ topK: 7 }));
  });

  it('passes modelRequestTimeoutMs to every model call', async () => {
    const { run } = await setup({ modelRequestTimeoutMs: 20 }, hangingBedrock());
    const started = Date.now();
    await expect(run()).rejects.toBeInstanceOf(ModelUnavailableError);
    // With the 120 s default the hanging client would never return in time.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('ends an exhausted run budget in ModelUnavailableError and still records the spend', async () => {
    // The router answers (billed); every later call hangs until the run budget aborts it.
    const answering = fakeBedrock();
    const client = {
      send: (command: { input: { system?: Array<{ text?: string }> } }, options?: unknown) =>
        (command.input.system?.[0]?.text ?? '').startsWith('You classify questions')
          ? answering.send(command)
          : hangingBedrock().send(command, options as never),
    };
    const { run, ledger } = await setup(
      { modelRequestTimeoutMs: 20_000, runBudgetMs: 300 },
      client,
    );
    const started = Date.now();
    const err = await run().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelUnavailableError);
    // Well inside the 20 s per-call timeout: the run budget ended it.
    expect(Date.now() - started).toBeLessThan(3_000);
    const routerCost = (200 * 0.035 + 10 * 0.14) / 1e6;
    expect(await ledger.spentUsd(singaporeDayKey(NOW))).toBeCloseTo(routerCost, 12);
  });
});
