import { AsyncLocalStorage } from 'node:async_hooks';
import {
  ConverseStructuredModel,
  createPassageRanker,
  createQuestionClassifier,
  createRulesAnswerer,
  loadModelCatalog,
  modelFor,
  type ConverseStructuredOptions,
  type EmbeddingsProvider,
  type ModelCallRecord,
} from '@bgr/ai';
import {
  createAnswerPipeline,
  currentRunDeadline,
  recordModelCall,
  setUnroutedCallListener,
  type AnswerOutcome,
  type SourceRecord,
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
  const model = new ConverseStructuredModel({
    onCall: recordModelCall,
    requestTimeoutMs: config.modelRequestTimeoutMs,
    // Both default to Date.now, the clock the pipeline sets the deadline on.
    deadline: currentRunDeadline,
    ...(parts.clientFactory ? { clientFactory: parts.clientFactory } : {}),
  });
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

  const inner = createAnswerPipeline({
    classifier: createQuestionClassifier(model, modelFor(catalog, 'router')),
    retriever,
    ranker: createPassageRanker(model, modelFor(catalog, 'reranker'), {
      maxRanked: config.rerankTopN,
    }),
    answerer: createRulesAnswerer(model, modelFor(catalog, 'answerer')),
    sources: async (chunks) => {
      const docs = new Map<string, SourceDocument | null>();
      for (const id of new Set(chunks.map((c) => c.documentId))) docs.set(id, await lookup(id));
      const out = new Map<string, SourceRecord>();
      for (const c of chunks) {
        const doc = docs.get(c.documentId);
        if (!doc) {
          logger.warn('chunk dropped: its document is missing', {
            chunkId: c.chunkId,
            documentId: c.documentId,
          });
          continue;
        }
        out.set(c.chunkId, {
          chunkId: c.chunkId,
          authority: doc.authority,
          provenance: doc.provenance,
          title: doc.title,
          sourceType: doc.sourceType,
          ...(doc.version === undefined ? {} : { version: doc.version }),
        });
      }
      return out;
    },
    ledger: parts.ledger,
    dailyCapUsd: config.dailyAiCapUsd,
    limits: config.evidenceLimits,
    now: parts.now ?? (() => new Date()),
    runBudgetMs: config.runBudgetMs,
    logger,
  });

  return {
    answer: (input, onCall) =>
      runDocuments.run(new Map(), async () => {
        const outcome = await inner.answer(input, onCall);
        const found = new Map<string, SourceDocument>();
        for (const [id, doc] of runDocuments.getStore() ?? []) if (doc) found.set(id, doc);
        return { ...outcome, documents: found };
      }),
  };
}
