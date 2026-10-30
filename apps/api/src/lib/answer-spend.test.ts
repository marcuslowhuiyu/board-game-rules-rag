import { describe, expect, it } from 'vitest';
import {
  ConverseStructuredModel,
  createPassageRanker,
  createQuestionClassifier,
  createRulesAnswerer,
  loadModelCatalog,
  modelFor,
} from '@bgr/ai';
import {
  createAnswerPipeline,
  recordModelCall,
  singaporeDayKey,
  type SourceRecord,
} from '@bgr/answering';
import { asContentId, asEditionId, asGameId } from '@bgr/domain';
import { InMemorySpendLedger } from '@bgr/persistence';
import type { RetrievedChunk } from '@bgr/retrieval';
import { createLogger } from '@bgr/shared';

const NOW = new Date('2026-10-30T10:00:00.000Z');

const chunk = (n: number): RetrievedChunk => ({
  chunkId: `ch${n}`,
  documentId: 'doc_1',
  gameId: 'g_1',
  editionId: 'e_1',
  contentId: 'c_1',
  authority: 'OFFICIAL_RULES',
  sourceType: 'RULEBOOK',
  headingPath: ['Combat'],
  pageStart: n,
  pageEnd: n,
  text: `rule text ${n}`,
  score: 1 - n / 10,
});

/** A Bedrock client whose Converse reply depends on which role's prompt it receives. */
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
        return reply('{"order":["P2","P1"]}', { inputTokens: 900, outputTokens: 20 });
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

describe('answer pipeline spend, with real roles and a fake Bedrock client', () => {
  it('records every model call in the ledger, cache tokens included', async () => {
    const catalog = loadModelCatalog();
    const model = new ConverseStructuredModel({
      onCall: recordModelCall,
      clientFactory: () => fakeBedrock() as never,
    });
    const ledger = new InMemorySpendLedger();
    const pipeline = createAnswerPipeline({
      classifier: createQuestionClassifier(model, modelFor(catalog, 'router')),
      retriever: { retrieve: async () => [chunk(1), chunk(2), chunk(3)] },
      ranker: createPassageRanker(model, modelFor(catalog, 'reranker'), { maxRanked: 10 }),
      answerer: createRulesAnswerer(model, modelFor(catalog, 'answerer')),
      sources: async (chunks) =>
        new Map(
          chunks.map((c): [string, SourceRecord] => [
            c.chunkId,
            {
              chunkId: c.chunkId,
              authority: 'OFFICIAL_RULES',
              provenance: [],
              title: 'Core Rulebook',
              sourceType: 'RULEBOOK',
            },
          ]),
        ),
      ledger,
      dailyCapUsd: 1,
      limits: { simple: 3, complex: 10 },
      now: () => NOW,
      logger: createLogger({ sink: () => undefined }),
    });

    const seen: string[] = [];
    const outcome = await pipeline.answer(
      {
        query: {
          gameId: asGameId('g_1'),
          editionId: asEditionId('e_1'),
          enabledContentIds: [asContentId('c_1')],
          text: 'May I attack twice?',
        },
        correlationId: 'req-1',
      },
      (r) => seen.push(r.role),
    );

    expect(outcome.answer.certainty).toBe('DEFINITIVE');
    expect(seen).toEqual(['router', 'reranker', 'answerer']);
    expect(outcome.calls).toHaveLength(3);
    const total = outcome.calls.reduce((sum, c) => sum + c.costUsd, 0);
    expect(total).toBeGreaterThan(0);
    // The answerer's cache write tokens are priced, not dropped.
    const answerer = outcome.calls.find((c) => c.role === 'answerer');
    expect(answerer?.cacheWriteInputTokens).toBe(400);
    expect(answerer?.costUsd).toBeCloseTo((700 * 0.1 + 120 * 0.5 + 300 * 0.1 + 400 * 0.1) / 1e6);
    expect(await ledger.spentUsd(singaporeDayKey(NOW))).toBeCloseTo(total, 12);
  });
});
