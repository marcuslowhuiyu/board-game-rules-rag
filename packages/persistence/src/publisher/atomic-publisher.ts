import type { Edition, GameId, IngestionJob, SourceDocument, SourceDocumentId } from '@bgr/domain';

/**
 * Arguments for one atomic publish. Everything that must succeed or fail
 * together is captured here so the transaction can be a single call.
 */
export interface PublishDocumentArgs {
  newDocument: SourceDocument;
  /**
   * Re-uploaded bytes match a SUPERSEDED document: `newDocument` is that
   * existing row (same `documentId`, status flipped back to CURRENT) and the
   * write is conditional on it still being SUPERSEDED instead of absent.
   * Its chunks are reused as-is.
   */
  reinstate?: boolean;
  /** Previous CURRENT document that must transition to SUPERSEDED. */
  supersedeDocumentId?: SourceDocumentId;
  gameId: GameId;
  /**
   * The complete new editions array for the game (with the target edition's
   * `knowledgeRevision` already bumped). Passed as a whole because editions
   * live embedded on the game row (ADR-0006 / ADR-0008).
   */
  nextEditions: readonly Edition[];
  /**
   * Value of `game.updatedAt` observed by the caller. The transaction fails
   * (as `PublishConflictError.reason === 'GAME_STALE'`) if the game row moved
   * underneath us — caller should retry FINALIZE.
   */
  expectedGameUpdatedAt: string;
  /**
   * The ingestion job in its final SUCCEEDED shape, written in the same
   * transaction so "document is CURRENT" and "job is SUCCEEDED" can never
   * disagree (ADR-0008 §FINALIZE). The write is conditional on the job row
   * still carrying `expectedJobUpdatedAt`; otherwise the publish fails as
   * `JOB_STALE`.
   */
  completedJob: IngestionJob;
  expectedJobUpdatedAt: string;
  /** Wall-clock timestamp to stamp on all mutated rows. */
  now: string;
}

/**
 * - `DOC_EXISTS` — the planned document is already present (an earlier
 *   attempt published it).
 * - `DOC_NOT_SUPERSEDED` / `PREV_NOT_CURRENT` / `GAME_STALE` / `JOB_STALE` —
 *   something moved underneath the caller; re-reading state and retrying may
 *   succeed.
 */
export type PublishConflictReason =
  'DOC_EXISTS' | 'DOC_NOT_SUPERSEDED' | 'PREV_NOT_CURRENT' | 'GAME_STALE' | 'JOB_STALE';

export class PublishConflictError extends Error {
  constructor(
    message: string,
    public readonly reason: PublishConflictReason,
  ) {
    super(message);
    this.name = 'PublishConflictError';
  }
}

/**
 * Atomically publishes a new authoritative `SourceDocument`:
 *   - the new document appears with `status = CURRENT` (or, with
 *     `reinstate`, an existing SUPERSEDED document returns to CURRENT),
 *   - the previous CURRENT document (if any) flips to `SUPERSEDED`,
 *   - the game's edition `knowledgeRevision` is bumped,
 *   - the ingestion job is marked SUCCEEDED,
 * all in one commit. On failure, none of the four mutations lands. See
 * ADR-0008 for the invariant this guarantees.
 */
export interface AtomicPublisher {
  publishDocument(args: PublishDocumentArgs): Promise<void>;
}
