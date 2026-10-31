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

/**
 * Retrieval infrastructure failed (query embedding, vector query or document lookup). Transient,
 * like a model failure: the caller should retry, and it is never reported as INCONCLUSIVE.
 */
export class RetrievalUnavailableError extends Error {
  override readonly cause: unknown;
  constructor(cause: unknown) {
    super('Rules retrieval failed');
    this.name = 'RetrievalUnavailableError';
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
 * with `onCall: recordModelCall` and `deadline: currentRunDeadline`. The run is
 * found via AsyncLocalStorage, so concurrent requests in one Lambda never mix
 * their costs or deadlines; a call made outside a pipeline run goes to
 * `setUnroutedCallListener`'s listener, if any, and has no deadline.
 */
interface RunScope {
  collect: (record: ModelCallRecord) => void;
  /** On the pipeline's `clock`; pass the same clock to the model as `now`. */
  deadline: number;
}
const runs = new AsyncLocalStorage<RunScope>();
let unroutedListener: ((record: ModelCallRecord) => void) | undefined;

/** Called with any record recorded outside a pipeline run (a mis-wired sink); wire it to a logger. */
export function setUnroutedCallListener(
  listener: ((record: ModelCallRecord) => void) | undefined,
): void {
  unroutedListener = listener;
}

export const recordModelCall: ModelCallSink = (record) => {
  const run = runs.getStore();
  if (run) run.collect(record);
  else unroutedListener?.(record);
};

/** The current run's deadline (ms on the pipeline's clock), or undefined outside a run. */
export const currentRunDeadline = (): number | undefined => runs.getStore()?.deadline;

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
  /**
   * Time allowed for all the model calls of one run, kept below the Lambda timeout so an
   * exhausted run still ends in `ModelUnavailableError` and records its spend.
   */
  runBudgetMs: number;
  /** Clock for the run deadline, in ms. Defaults to `Date.now`. */
  clock?: () => number;
  /** Required: a failed ledger write is only visible in the log. */
  logger: Logger;
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

  const retrieval = async <T>(step: () => Promise<T>): Promise<T> => {
    try {
      return await step();
    } catch (error) {
      throw new RetrievalUnavailableError(error);
    }
  };

  async function run(
    input: { query: RetrievalQuery; correlationId: string },
    day: string,
  ): Promise<Omit<AnswerOutcome, 'calls'>> {
    const { query, correlationId } = input;
    const options = { logger, correlationId };

    const route = await routeQuestion(query.text, deps.classifier, options);
    const candidates = await retrieval(() => deps.retriever.retrieve(query));
    const { ranked } = await rerankEvidence(query.text, candidates, deps.ranker, options);
    // Look up every reranked candidate, so chunks without a source do not shrink the kept set.
    const found =
      ranked.length === 0
        ? new Map<string, SourceRecord>()
        : await retrieval(() => deps.sources(ranked));
    const passages = ranked
      .filter((c) => found.has(c.chunkId))
      .slice(0, evidenceLimit(route.tier, deps.limits));

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
        logger.error('answerer returned unusable output', {
          modelFailure: true,
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
        const deadline = (deps.clock ?? Date.now)() + deps.runBudgetMs;
        const outcome = await runs.run({ collect, deadline }, () => run(input, day));
        return { ...outcome, calls };
      } finally {
        const total = calls.reduce((sum, c) => sum + c.costUsd, 0);
        if (total > 0) {
          try {
            await deps.ledger.add(day, total);
          } catch (error) {
            logger.error('failed to record AI spend', {
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
