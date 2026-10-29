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
