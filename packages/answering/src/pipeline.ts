import { AsyncLocalStorage } from 'node:async_hooks';
import {
  ModelCallError,
  ModelOutputError,
  type ModelCallRecord,
  type ModelCallSink,
  type PassageRanker,
  type QuestionClassifier,
  type QuestionTier,
  type RulesAnswerer,
} from '@bgr/ai';
import { panelTierOf, type RulesAnswer, type SourceType } from '@bgr/domain';
import {
  evidenceLimit,
  rerankEvidence,
  routeQuestion,
  type EvidenceLimits,
  type RetrievalQuery,
  type RetrievedChunk,
  type RulesRetriever,
} from '@bgr/retrieval';
import type { Logger } from '@bgr/shared';
import { singaporeDayKey, type SpendLedger } from './spend-ledger.js';
import { inconclusiveAnswer, validateAnswer, type CitedSource } from './validate-answer.js';

export class DailyLimitReachedError extends Error {
  constructor() {
    super('The daily AI spend cap has been reached');
    this.name = 'DailyLimitReachedError';
  }
}

export class ModelUnavailableError extends Error {
  override readonly cause: unknown;
  constructor(cause: unknown) {
    super('A model call failed');
    this.name = 'ModelUnavailableError';
    this.cause = cause;
  }
}

/** A cited source plus the document facts the answerer prompt shows. */
export type SourceRecord = CitedSource & {
  title: string;
  sourceType: SourceType;
  version?: string;
};

/**
 * Every model call of one `answer()` run reaches that run's collector through
 * this sink, including router and reranker calls whose errors those stages
 * swallow. Build the router, reranker and answerer `ConverseStructuredModel`s
 * with `onCall: recordModelCall`. The collector is found via AsyncLocalStorage,
 * so concurrent requests in one Lambda never mix their costs; a call made
 * outside a pipeline run is ignored.
 */
const collectors = new AsyncLocalStorage<(record: ModelCallRecord) => void>();
export const recordModelCall: ModelCallSink = (record) => collectors.getStore()?.(record);

export interface AnswerPipelineDeps {
  classifier: QuestionClassifier;
  retriever: RulesRetriever;
  ranker: PassageRanker;
  answerer: RulesAnswerer;
  /** Provenance and document facts by chunk id; chunks without an entry are dropped. */
  sources: (chunks: readonly RetrievedChunk[]) => Promise<Map<string, SourceRecord>>;
  ledger: SpendLedger;
  dailyCapUsd: number;
  limits: EvidenceLimits;
  now: () => Date;
  logger?: Logger;
}

export interface AnswerOutcome {
  answer: RulesAnswer;
  passages: RetrievedChunk[];
  tier: QuestionTier;
  calls: ModelCallRecord[];
}

export function createAnswerPipeline(deps: AnswerPipelineDeps): {
  answer(
    input: { query: RetrievalQuery; correlationId: string },
    onCall: (r: ModelCallRecord) => void,
  ): Promise<AnswerOutcome>;
} {
  const { logger } = deps;

  async function run(
    input: { query: RetrievalQuery; correlationId: string },
    day: string,
  ): Promise<Omit<AnswerOutcome, 'calls'>> {
    const { query, correlationId } = input;
    const options = { ...(logger ? { logger } : {}), correlationId };

    const route = await routeQuestion(query.text, deps.classifier, options);
    const candidates = await deps.retriever.retrieve(query);
    const { ranked } = await rerankEvidence(query.text, candidates, deps.ranker, options);
    const kept = ranked.slice(0, evidenceLimit(route.tier, deps.limits));
    const found = kept.length === 0 ? new Map<string, SourceRecord>() : await deps.sources(kept);
    const passages = kept.filter((c) => found.has(c.chunkId));

    if (passages.length === 0) {
      return {
        answer: inconclusiveAnswer('No rules passages were found for this question.'),
        passages: [],
        tier: route.tier,
      };
    }

    const answerPassages = passages.map((c) => {
      const s = found.get(c.chunkId) as SourceRecord;
      return {
        id: c.chunkId,
        text: c.text,
        headingPath: c.headingPath,
        tier: panelTierOf(s.authority),
        sourceType: s.sourceType,
        title: s.title,
        ...(s.version === undefined ? {} : { version: s.version }),
      };
    });

    try {
      const { output, labels } = await deps.answerer.answer(
        query.text,
        answerPassages,
        correlationId,
      );
      return { answer: validateAnswer(output, labels, found), passages, tier: route.tier };
    } catch (error) {
      if (error instanceof ModelOutputError) {
        logger?.warn('answerer returned unusable output', {
          correlationId,
          day,
          error: `${error.name}: ${error.message}`,
        });
        return {
          answer: inconclusiveAnswer(
            'The answer could not be produced reliably for this question.',
          ),
          passages,
          tier: route.tier,
        };
      }
      if (error instanceof ModelCallError) throw new ModelUnavailableError(error);
      throw error;
    }
  }

  return {
    async answer(input, onCall) {
      const day = singaporeDayKey(deps.now());
      if ((await deps.ledger.spentUsd(day)) >= deps.dailyCapUsd) throw new DailyLimitReachedError();

      const calls: ModelCallRecord[] = [];
      const collect = (record: ModelCallRecord): void => {
        calls.push(record);
        onCall(record);
      };
      try {
        const outcome = await collectors.run(collect, () => run(input, day));
        return { ...outcome, calls };
      } finally {
        const total = calls.reduce((sum, c) => sum + c.costUsd, 0);
        if (total > 0) {
          try {
            await deps.ledger.add(day, total);
          } catch (error) {
            logger?.error('failed to record AI spend', {
              correlationId: input.correlationId,
              day,
              usd: total,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    },
  };
}
