export const PACKAGE_NAME = '@bgr/ai';

export type { EmbeddingResult, EmbeddingsProvider } from './embeddings/embeddings-provider.js';
export {
  TITAN_V2_DIMENSIONS,
  TitanEmbeddingsProvider,
  type TitanDimensions,
  type TitanEmbeddingsOptions,
} from './embeddings/titan-embeddings.js';

export {
  MODEL_ROLES,
  ModelCatalogSchema,
  costUsd,
  loadModelCatalog,
  modelFor,
  type ModelCatalog,
  type ModelEntry,
  type ModelRole,
} from './models/catalog.js';

export {
  ConverseStructuredModel,
  ModelCallError,
  ModelOutputError,
  type ConverseStructuredOptions,
  type StructuredModel,
  type StructuredRequest,
  type StructuredResult,
} from './bedrock/converse-structured.js';
export type { ModelCallRecord, ModelCallSink } from './models/telemetry.js';

export {
  ROUTER_PROMPT_VERSION,
  createQuestionClassifier,
  type QuestionClassifier,
  type QuestionTier,
} from './roles/question-classifier.js';
export {
  RERANKER_PROMPT_VERSION,
  createPassageRanker,
  type PassageRanker,
  type RankablePassage,
} from './roles/passage-ranker.js';
export {
  ANSWERER_PROMPT_VERSION,
  createRulesAnswerer,
  type AnswerPassage,
  type ModelAnswer,
  type RulesAnswerer,
} from './roles/rules-answerer.js';
