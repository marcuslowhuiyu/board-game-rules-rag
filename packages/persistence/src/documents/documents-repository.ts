import type {
  ContentId,
  EditionId,
  GameId,
  SourceDocument,
  SourceDocumentId,
  SourceType,
} from '@bgr/domain';

export interface DocumentsRepository {
  /** Insert a new document. Fails with ConflictError if `documentId` already exists. */
  createDocument(doc: SourceDocument): Promise<void>;
  /** Direct lookup by id — used by `GET /sources/{sourceId}` and Finalize. */
  getDocument(documentId: SourceDocumentId): Promise<SourceDocument | null>;
  /** All documents for an edition (any status). Small-scale scan; see ADR-0008. */
  listDocumentsForEdition(gameId: GameId, editionId: EditionId): Promise<SourceDocument[]>;
  /**
   * Look up by dedup key — same edition + same raw bytes.
   * Returns any status (so we can short-circuit on ACTIVE or refuse re-ingest of an ARCHIVED).
   * See MASTER_PLAN §18.
   */
  findByContentHash(
    gameId: GameId,
    editionId: EditionId,
    contentHash: string,
  ): Promise<SourceDocument | null>;
  /**
   * Look up the current version for a given content/sourceType combination
   * within an edition (e.g. the CURRENT `RULEBOOK` for the Base content).
   * Used by Finalize to decide who becomes SUPERSEDED.
   */
  findCurrentByKey(
    gameId: GameId,
    editionId: EditionId,
    contentId: ContentId,
    sourceType: SourceType,
  ): Promise<SourceDocument | null>;
  /** Flip a document to SUPERSEDED. Idempotent — safe to call twice. */
  markSuperseded(documentId: SourceDocumentId, updatedAt: string): Promise<void>;
  /** Record the number of chunks emitted for a document (fills after CHUNK stage). */
  updateChunkCount(
    documentId: SourceDocumentId,
    chunkCount: number,
    updatedAt: string,
  ): Promise<void>;
}
