import {
  loadModelCatalog,
  type ModelCatalog,
  type ModelRole,
  type QuestionClassifier,
  type QuestionTier,
} from '@bgr/ai';
import { InMemorySpendLedger, type DocumentsRepository } from '@bgr/persistence';
import {
  createAnswerPipeline,
  createAnswerRoles,
  createSourceLookup,
  type AnswerRoles,
  type ConverseClientFactory,
} from '@bgr/answering';
import { asSourceDocumentId } from '@bgr/domain';
import type { RulesRetriever } from '@bgr/retrieval';
import { createLogger, type Logger } from '@bgr/shared';
import type { EvalConfig } from '../scoring/aggregate.js';
import { createDevDocuments, createDevRetriever } from './aws.js';

export type EvalPipeline = Pick<ReturnType<typeof createAnswerPipeline>, 'answer'>;

export interface EvalAnswerPipeline {
  pipeline: EvalPipeline;
  models: AnswerRoles['models'];
  promptVersions: AnswerRoles['promptVersions'];
}

/**
 * The real answer pipeline, in process, as the Lambda builds it, minus the API and the daily cap
 * (the eval's own `--max-cost` meter caps spend). Keys override the catalog defaults for this run
 * only; an unapproved key throws here, before any call. With `tierFor`, the router is never
 * called: each question gets its labelled tier, which measures what routing costs.
 *
 * The retriever and documents default to the dev stack (env from `scripts/dev-env.sh`); tests
 * pass in-memory ones and a fake Bedrock `clientFactory`.
 */
export function createEvalAnswerPipeline(opts: {
  keys: Partial<Record<ModelRole, string>>;
  config: Pick<EvalConfig, 'topK' | 'rerankTopN' | 'answer'>;
  tierFor?: (question: string) => QuestionTier;
  catalog?: ModelCatalog;
  clientFactory?: ConverseClientFactory;
  retriever?: RulesRetriever;
  documents?: Pick<DocumentsRepository, 'getDocument'>;
  logger?: Logger;
}): EvalAnswerPipeline {
  const { config } = opts;
  const roles = createAnswerRoles({
    catalog: opts.catalog ?? loadModelCatalog(),
    keys: opts.keys,
    requestTimeoutMs: config.answer.requestTimeoutMs,
    rerankTopN: config.rerankTopN,
    ...(opts.clientFactory ? { clientFactory: opts.clientFactory } : {}),
  });
  const { tierFor } = opts;
  const classifier: QuestionClassifier = tierFor
    ? {
        // No call is made: the record is never sent to the run's sink, so it costs nothing.
        classify: async (question) => ({
          tier: tierFor(question),
          record: {
            role: 'router',
            modelKey: 'labelled-tier',
            modelId: 'labelled-tier',
            promptVersion: 'labelled-tier',
            inputTokens: 0,
            cacheReadInputTokens: 0,
            cacheWriteInputTokens: 0,
            outputTokens: 0,
            latencyMs: 0,
            costUsd: 0,
            attempts: 0,
            ok: true,
          },
        }),
      }
    : roles.classifier;
  const documents = opts.documents ?? createDevDocuments();
  const retriever = opts.retriever ?? createDevRetriever(config.topK);
  // Per-call info logs would flood the eval output; failures still show.
  const logger =
    opts.logger ??
    createLogger({ level: 'warn', sink: (line) => process.stderr.write(line + '\n') });

  const pipeline = createAnswerPipeline({
    classifier,
    retriever,
    ranker: roles.ranker,
    answerer: roles.answerer,
    sources: createSourceLookup({
      getDocument: (id) => documents.getDocument(asSourceDocumentId(id)),
      logger,
    }),
    ledger: new InMemorySpendLedger(),
    dailyCapUsd: Number.POSITIVE_INFINITY,
    limits: config.answer.evidenceLimits,
    now: () => new Date(),
    runBudgetMs: config.answer.runBudgetMs,
    logger,
  });
  return { pipeline, models: roles.models, promptVersions: roles.promptVersions };
}
