import { describe, expect, it, vi } from 'vitest';
import {
  ANSWERER_PROMPT_VERSION,
  RERANKER_PROMPT_VERSION,
  ROUTER_PROMPT_VERSION,
  loadModelCatalog,
  modelFor,
  type ModelCatalog,
} from '@bgr/ai';
import { asContentId, asEditionId, asGameId } from '@bgr/domain';
import type { RetrievedChunk } from '@bgr/retrieval';
import { createLogger } from '@bgr/shared';
import { createAnswerPipeline } from './pipeline.js';
import { createAnswerRoles } from './roles.js';

const base = loadModelCatalog();
// A catalog with a second approved model for the answerer only.
const catalog: ModelCatalog = {
  ...base,
  models: { ...base.models, alt: { ...base.models[base.defaults.answerer]!, key: 'alt' } },
  approved: { ...base.approved, answerer: [...base.approved.answerer, 'alt'] },
};

const opts = { catalog, requestTimeoutMs: 1000, rerankTopN: 5 };

describe('createAnswerRoles', () => {
  it('defaults come from the catalog', () => {
    const { models, promptVersions } = createAnswerRoles(opts);
    for (const role of ['router', 'reranker', 'answerer'] as const) {
      const entry = modelFor(catalog, role);
      expect(models[role]).toEqual({ key: entry.key, modelId: entry.modelId });
    }
    expect(promptVersions).toEqual({
      router: ROUTER_PROMPT_VERSION,
      reranker: RERANKER_PROMPT_VERSION,
      answerer: ANSWERER_PROMPT_VERSION,
    });
    expect(promptVersions).toEqual({
      router: 'router-v2',
      reranker: 'reranker-v2',
      answerer: 'answerer-v3',
    });
  });

  it('key override picks the approved model for that role only', () => {
    const { models } = createAnswerRoles({ ...opts, keys: { answerer: 'alt' } });
    expect(models.answerer.key).toBe('alt');
    expect(models.router.key).toBe(catalog.defaults.router);
    expect(models.reranker.key).toBe(catalog.defaults.reranker);
  });

  it('unapproved override throws before any call', () => {
    const clientFactory = vi.fn();
    expect(() =>
      createAnswerRoles({
        ...opts,
        keys: { router: 'alt' },
        clientFactory: clientFactory as never,
      }),
    ).toThrow('not approved for router');
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it('calls made inside a pipeline run reach AnswerOutcome.calls', async () => {
    const reply = (text: string) => ({
      output: { message: { role: 'assistant', content: [{ text }] } },
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    const modelAnswer = {
      appliedTier: 'OFFICIAL',
      certainty: 'DEFINITIVE',
      answer: 'Yes.',
      explanation: 'Rule 1.',
      evidence: ['P1'],
      tiers: [
        {
          tier: 'OFFICIAL',
          answer: 'Yes.',
          certainty: 'DEFINITIVE',
          evidence: ['P1'],
          disagreesWithApplied: false,
        },
      ],
    };
    const client = {
      async send(command: { input: { system?: Array<{ text?: string }> } }) {
        const system = command.input.system?.[0]?.text ?? '';
        if (system.startsWith('You classify questions')) return reply('{"tier":"simple"}');
        if (system.startsWith('You rank passages')) return reply('{"order":["P1"]}');
        if (system.startsWith('You answer questions')) return reply(JSON.stringify(modelAnswer));
        throw new Error(`unexpected prompt: ${system.slice(0, 40)}`);
      },
    };
    const { classifier, ranker, answerer } = createAnswerRoles({
      ...opts,
      clientFactory: () => client as never,
    });
    const chunk = {
      chunkId: 'ch1',
      documentId: 'doc_1',
      headingPath: ['Combat'],
      text: 'rule text',
    } as RetrievedChunk;
    const pipeline = createAnswerPipeline({
      classifier,
      ranker,
      answerer,
      retriever: { retrieve: async () => [chunk] },
      sources: async () =>
        new Map([
          [
            'ch1',
            {
              chunkId: 'ch1',
              authority: 'OFFICIAL_RULES',
              provenance: [],
              title: 'T',
              sourceType: 'RULEBOOK',
            },
          ],
        ]) as never,
      ledger: { spentUsd: async () => 0, add: async () => undefined },
      dailyCapUsd: 1,
      limits: { simple: 3, complex: 10 },
      now: () => new Date('2026-10-30T10:00:00Z'),
      runBudgetMs: 10_000,
      logger: createLogger({ sink: () => undefined }),
    });
    const outcome = await pipeline.answer(
      {
        query: {
          gameId: asGameId('g_1'),
          editionId: asEditionId('e_1'),
          enabledContentIds: [asContentId('c_1')],
          text: 'May I attack twice?',
        },
        correlationId: 'r1',
      },
      () => undefined,
    );
    expect(outcome.calls.map((c) => c.role)).toEqual(['router', 'reranker', 'answerer']);
  });
});
