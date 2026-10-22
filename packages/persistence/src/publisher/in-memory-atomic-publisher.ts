import type { InMemoryDocumentsRepository } from '../documents/in-memory-documents-repository.js';
import type { InMemoryGamesRepository } from '../games/in-memory-games-repository.js';
import type { InMemoryIngestionJobsRepository } from '../ingestion-jobs/in-memory-ingestion-jobs-repository.js';
import {
  PublishConflictError,
  type AtomicPublisher,
  type PublishDocumentArgs,
} from './atomic-publisher.js';

/**
 * In-memory `AtomicPublisher`. JavaScript is single-threaded, so checks and
 * writes that run without yielding to the event loop are atomic against
 * every other operation on the same repos — the guarantee the DynamoDB
 * implementation gets from `TransactWriteItems`.
 *
 * Hence the checks use the repos' synchronous `peek*` reads, and every write
 * is *started* (its body runs synchronously up to its first await, and the
 * in-memory repos never await) before anything is awaited.
 */
export class InMemoryAtomicPublisher implements AtomicPublisher {
  constructor(
    private readonly documents: InMemoryDocumentsRepository,
    private readonly games: InMemoryGamesRepository,
    private readonly jobs: InMemoryIngestionJobsRepository,
  ) {}

  async publishDocument(args: PublishDocumentArgs): Promise<void> {
    // --- Check (no awaits) ---
    if (args.supersedeDocumentId === args.newDocument.documentId) {
      // DynamoDB rejects a transaction with two operations on one item as a
      // request validation error — before any condition is evaluated.
      const err = new Error('Transaction request cannot include multiple operations on one item');
      err.name = 'ValidationException';
      throw err;
    }
    const game = this.games.peekGame(args.gameId);
    if (!game) {
      throw new PublishConflictError(`game not found: ${args.gameId}`, 'GAME_STALE');
    }
    if (game.updatedAt !== args.expectedGameUpdatedAt) {
      throw new PublishConflictError(
        `game ${args.gameId} moved (updatedAt ${game.updatedAt} != expected ${args.expectedGameUpdatedAt})`,
        'GAME_STALE',
      );
    }
    const existingDoc = this.documents.peekDocument(args.newDocument.documentId);
    if (args.reinstate) {
      if (existingDoc?.status !== 'SUPERSEDED') {
        throw new PublishConflictError(
          `document ${args.newDocument.documentId} is no longer SUPERSEDED`,
          'DOC_NOT_SUPERSEDED',
        );
      }
    } else if (existingDoc) {
      throw new PublishConflictError(
        `document already exists: ${args.newDocument.documentId}`,
        'DOC_EXISTS',
      );
    }
    const job = this.jobs.peekJob(args.completedJob.jobId);
    if (!job || job.updatedAt !== args.expectedJobUpdatedAt) {
      throw new PublishConflictError(
        `ingestion job ${args.completedJob.jobId} moved (expected updatedAt ${args.expectedJobUpdatedAt})`,
        'JOB_STALE',
      );
    }
    if (args.supersedeDocumentId) {
      const prev = this.documents.peekDocument(args.supersedeDocumentId);
      if (prev?.status !== 'CURRENT') {
        throw new PublishConflictError(
          `supersede target is not CURRENT: ${args.supersedeDocumentId} (${prev?.status ?? 'missing'})`,
          'PREV_NOT_CURRENT',
        );
      }
    }

    // --- Apply (all writes start before the first await) ---
    const writes: Promise<unknown>[] = [];
    if (args.reinstate) this.documents.putDocument(args.newDocument);
    else writes.push(this.documents.createDocument(args.newDocument));
    if (args.supersedeDocumentId) {
      writes.push(this.documents.markSuperseded(args.supersedeDocumentId, args.now));
    }
    writes.push(
      this.games.replaceEditions(
        args.gameId,
        args.nextEditions,
        args.now,
        args.expectedGameUpdatedAt,
      ),
    );
    const { jobId, createdAt: _createdAt, ...rest } = args.completedJob;
    writes.push(this.jobs.updateJob(jobId, rest, args.completedJob.updatedAt));
    await Promise.all(writes);
  }
}
