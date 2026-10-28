import type {
  ContentId,
  EditionId,
  GameId,
  ProvenanceEvidence,
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
   * Look up by dedup key — same (game, edition, contentId, contentHash).
   * See MASTER_PLAN §18 and ADR-0008: `contentId` is part of the identity
   * because the same bytes may legitimately be attached to different content
   * packages (e.g. a base-rulebook PDF also uploaded against a promo pack).
   * `sourceType` is intentionally NOT part of the dedup key — the same
   * document should not be re-ingested twice for a single content package
   * simply because the operator toggled the source-type dropdown.
   * Returns any status (CURRENT/SUPERSEDED/ARCHIVED).
   */
  findByContentHash(
    gameId: GameId,
    editionId: EditionId,
    contentId: ContentId,
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
  /**
   * Replace the provenance list. Optimistic: throws `NotFoundError` if the
   * document is missing and `ConflictError` if its stored `updatedAt` differs
   * from `expectedUpdatedAt`.
   */
  setProvenance(
    documentId: SourceDocumentId,
    provenance: ProvenanceEvidence[],
    expectedUpdatedAt: string,
    updatedAt: string,
  ): Promise<void>;
  /** Record the number of chunks emitted for a document (fills after CHUNK stage). */
  updateChunkCount(
    documentId: SourceDocumentId,
    chunkCount: number,
    updatedAt: string,
  ): Promise<void>;
}
