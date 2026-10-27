export const PACKAGE_NAME = '@bgr/ai';

export type { EmbeddingResult, EmbeddingsProvider } from './embeddings/embeddings-provider.js';
export {
  TITAN_V2_DIMENSIONS,
  TitanEmbeddingsProvider,
  type TitanDimensions,
  type TitanEmbeddingsOptions,
} from './embeddings/titan-embeddings.js';
