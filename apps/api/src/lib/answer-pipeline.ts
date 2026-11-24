import { AsyncLocalStorage } from 'node:async_hooks';
import {
  loadModelCatalog,
  type ModelRole,
  type ConverseStructuredOptions,
  type EmbeddingsProvider,
  type ModelCallRecord,
} from '@bgr/ai';
import {
  createAnswerPipeline,
  createAnswerRoles,
  createSourceLookup,
  setUnroutedCallListener,
  type AnswerOutcome,
} from '@bgr/answering';
import { asSourceDocumentId, type SourceDocument } from '@bgr/domain';
import type { DocumentsRepository, SpendLedger } from '@bgr/persistence';
import { VectorRulesRetriever, type EvidenceLimits, type VectorIndex } from '@bgr/retrieval';
import type { Logger } from '@bgr/shared';

/** Settings of the answer pipeline; read lazily, on the first question (set by CDK). */
export interface AnsweringConfig {
  usageTable: string;
  dailyAiCapUsd: number;
  modelRequestTimeoutMs: number;
  evidenceLimits: EvidenceLimits;
  rerankCandidates: number;
  rerankTopN: number;
  /** Time allowed for all model calls of one question; below the Lambda timeout. */
  runBudgetMs: number;
  /** How long a stored model choice is reused before it is read again. */
  modelSettingsCacheMs: number;
}

/** The outcome plus every document the run looked up, so citations need no second read. */
export type AnswerRun = AnswerOutcome & { documents: ReadonlyMap<string, SourceDocument> };

export interface AnswerPipeline {
  answer(
    input: Parameters<ReturnType<typeof createAnswerPipeline>['answer']>[0],
    onCall: (record: ModelCallRecord) => void,
  ): Promise<AnswerRun>;
}

export interface AnswerPipelineParts {
  config: AnsweringConfig;
  documents: Pick<DocumentsRepository, 'getDocument' | 'listDocumentsForEdition'>;
  ledger: SpendLedger;
  embeddings: EmbeddingsProvider;
  index: VectorIndex;
  logger: Logger;
  /** The catalog key for each role, for this question. */
  modelKeys: () => Promise<Record<ModelRole, string>>;
  /** Tests inject a fake Bedrock client here. */
  clientFactory?: ConverseStructuredOptions['clientFactory'];
  now?: () => Date;
}

/** Documents looked up during one answer run, by id; shared between `sources` and the result. */
const runDocuments = new AsyncLocalStorage<Map<string, SourceDocument | null>>();

/**
 * The Lambda's answer pipeline. Adapters (Bedrock client, embeddings, vector
 * index, documents, ledger) come in through `parts`; the wiring of spend
 * recording, limits, timeouts and source lookup is all here.
 */
export function buildAnswerPipeline(parts: AnswerPipelineParts): AnswerPipeline {
  const { config, documents, logger } = parts;
  setUnroutedCallListener((record) =>
    logger.error('model call outside an answer run', { ...record }),
  );

  const catalog = loadModelCatalog();
  const retriever = new VectorRulesRetriever({
    embeddings: parts.embeddings,
    index: parts.index,
    documents,
    topK: config.rerankCandidates,
  });

  const lookup = async (id: string): Promise<SourceDocument | null> => {
    const seen = runDocuments.getStore();
    if (seen?.has(id)) return seen.get(id) ?? null;
    const doc = await documents.getDocument(asSourceDocumentId(id));
    seen?.set(id, doc);
    return doc;
  };

  /** One pipeline per role-to-model assignment; the roles are built on first use. */
  const pipelines = new Map<string, ReturnType<typeof createAnswerPipeline>>();
  const pipelineFor = (keys: Record<ModelRole, string>) => {
    const id = `${keys.router}|${keys.reranker}|${keys.answerer}`;
    let inner = pipelines.get(id);
    if (!inner) {
      const { classifier, ranker, answerer } = createAnswerRoles({
        catalog,
        keys,
        requestTimeoutMs: config.modelRequestTimeoutMs,
        rerankTopN: config.rerankTopN,
        ...(parts.clientFactory ? { clientFactory: parts.clientFactory } : {}),
      });
      inner = createAnswerPipeline({
        classifier,
        retriever,
        ranker,
        answerer,
        sources: createSourceLookup({ getDocument: lookup, logger }),
        ledger: parts.ledger,
        dailyCapUsd: config.dailyAiCapUsd,
        limits: config.evidenceLimits,
        now: parts.now ?? (() => new Date()),
        runBudgetMs: config.runBudgetMs,
        logger,
      });
      pipelines.set(id, inner);
    }
    return inner;
  };

  return {
    answer: (input, onCall) =>
      runDocuments.run(new Map(), async () => {
        const inner = pipelineFor(await parts.modelKeys());
        const outcome = await inner.answer(input, onCall);
        const found = new Map<string, SourceDocument>();
        for (const [id, doc] of runDocuments.getStore() ?? []) if (doc) found.set(id, doc);
        return { ...outcome, documents: found };
      }),
  };
}
