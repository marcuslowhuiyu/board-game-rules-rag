import type { Edition, GameId, SourceDocument, SourceDocumentId } from '@bgr/domain';

/**
 * Arguments for one atomic publish. Everything that must succeed or fail
 * together is captured here so the transaction can be a single call.
 */
export interface PublishDocumentArgs {
  newDocument: SourceDocument;
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
  /** Wall-clock timestamp to stamp on all mutated rows. */
  now: string;
}

export class PublishConflictError extends Error {
  constructor(
    message: string,
    public readonly reason: 'DOC_EXISTS' | 'PREV_NOT_CURRENT' | 'GAME_STALE',
  ) {
    super(message);
    this.name = 'PublishConflictError';
  }
}

/**
 * Atomically publishes a new authoritative `SourceDocument`:
 *   - the new document appears with `status = CURRENT`,
 *   - the previous CURRENT document (if any) flips to `SUPERSEDED`,
 *   - the game's edition `knowledgeRevision` is bumped,
 * all in one commit. On failure, none of the three mutations lands. See
 * ADR-0008 for the invariant this guarantees.
 */
export interface AtomicPublisher {
  publishDocument(args: PublishDocumentArgs): Promise<void>;
}
