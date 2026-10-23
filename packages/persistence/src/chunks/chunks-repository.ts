import type { Chunk, SourceDocumentId } from '@bgr/domain';

export interface ChunksRepository {
  /** Insert (or overwrite) a batch of chunks. Idempotent by (documentId, chunkId). */
  putChunks(chunks: Chunk[]): Promise<void>;
  /** All chunks for a document, ordered by `ordinal` ascending. */
  listChunksForDocument(documentId: SourceDocumentId): Promise<Chunk[]>;
  /** Remove every chunk belonging to a document. Used when re-running CHUNK. */
  deleteChunksForDocument(documentId: SourceDocumentId): Promise<void>;
}
