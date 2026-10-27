import { AuthoritySchema, SourceTypeSchema } from '@bgr/domain';
import { z } from 'zod';

/**
 * What each chunk vector carries. The ids are filterable (S3 Vectors allows
 * 2 KB of filterable metadata per vector); the chunk body and its location
 * are stored as non-filterable metadata (40 KB in total), so a query returns
 * evidence without a second read. The vector key is the `chunkId`.
 */
export const ChunkVectorMetadataSchema = z.object({
  gameId: z.string().min(1),
  editionId: z.string().min(1),
  contentId: z.string().min(1),
  documentId: z.string().min(1),
  authority: AuthoritySchema,
  sourceType: SourceTypeSchema,
  headingPath: z.array(z.string()),
  pageStart: z.number().int().positive(),
  pageEnd: z.number().int().positive(),
  text: z.string().min(1),
  documentVersion: z.string().optional(),
});
export type ChunkVectorMetadata = z.infer<typeof ChunkVectorMetadataSchema>;

/**
 * Metadata keys an index must declare non-filterable when it is created.
 * They are too large for, or useless in, filters.
 */
export const NON_FILTERABLE_METADATA_KEYS = [
  'text',
  'headingPath',
  'pageStart',
  'pageEnd',
  'documentVersion',
] as const satisfies readonly (keyof ChunkVectorMetadata)[];

/** Every query is scoped to one game edition's current documents. */
export interface VectorFilter {
  gameId: string;
  editionId: string;
  documentIds: readonly string[];
}

export interface VectorHit {
  key: string;
  /** Cosine similarity: 1 is identical, 0 unrelated. */
  score: number;
  metadata: ChunkVectorMetadata;
}

export interface VectorItem {
  key: string;
  vector: number[];
  metadata: ChunkVectorMetadata;
}

/** Storage seam for chunk vectors. `S3VectorIndex` is the real one. */
export interface VectorIndex {
  /** Insert or overwrite vectors by key. */
  putVectors(items: readonly VectorItem[]): Promise<void>;
  /** Nearest vectors that match `filter`, best first. */
  query(input: { vector: number[]; topK: number; filter: VectorFilter }): Promise<VectorHit[]>;
}

export function matchesFilter(metadata: ChunkVectorMetadata, filter: VectorFilter): boolean {
  return (
    metadata.gameId === filter.gameId &&
    metadata.editionId === filter.editionId &&
    filter.documentIds.includes(metadata.documentId)
  );
}
