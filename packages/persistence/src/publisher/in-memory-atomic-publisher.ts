import type { InMemoryDocumentsRepository } from '../documents/in-memory-documents-repository.js';
import type { InMemoryGamesRepository } from '../games/in-memory-games-repository.js';
import {
  PublishConflictError,
  type AtomicPublisher,
  type PublishDocumentArgs,
} from './atomic-publisher.js';

/**
 * In-memory `AtomicPublisher`. JavaScript is single-threaded, so a
 * check-then-apply block that does not `await` between the reads and the
 * writes is atomic against other operations on the same repos. That
 * property matches the guarantees the DynamoDB implementation gets from
 * `TransactWriteItems`.
 */
export class InMemoryAtomicPublisher implements AtomicPublisher {
  constructor(
    private readonly documents: InMemoryDocumentsRepository,
    private readonly games: InMemoryGamesRepository,
  ) {}

  async publishDocument(args: PublishDocumentArgs): Promise<void> {
    // Pre-flight checks.
    const game = await this.games.getGame(args.gameId);
    if (!game) {
      throw new PublishConflictError(`game not found: ${args.gameId}`, 'GAME_STALE');
    }
    if (game.updatedAt !== args.expectedGameUpdatedAt) {
      throw new PublishConflictError(
        `game ${args.gameId} moved (updatedAt ${game.updatedAt} != expected ${args.expectedGameUpdatedAt})`,
        'GAME_STALE',
      );
    }
    if (await this.documents.getDocument(args.newDocument.documentId)) {
      throw new PublishConflictError(
        `document already exists: ${args.newDocument.documentId}`,
        'DOC_EXISTS',
      );
    }
    if (args.supersedeDocumentId) {
      const prev = await this.documents.getDocument(args.supersedeDocumentId);
      if (!prev) {
        throw new PublishConflictError(
          `supersede target missing: ${args.supersedeDocumentId}`,
          'PREV_NOT_CURRENT',
        );
      }
      if (prev.status !== 'CURRENT') {
        throw new PublishConflictError(
          `supersede target is not CURRENT: ${args.supersedeDocumentId} (${prev.status})`,
          'PREV_NOT_CURRENT',
        );
      }
    }

    // Apply — no awaits between check and apply so this block is atomic in
    // the JS event loop.
    await this.documents.createDocument(args.newDocument);
    if (args.supersedeDocumentId) {
      await this.documents.markSuperseded(args.supersedeDocumentId, args.now);
    }
    await this.games.replaceEditions(
      args.gameId,
      args.nextEditions,
      args.now,
      args.expectedGameUpdatedAt,
    );
  }
}
