import { describe, expect, it } from 'vitest';
import {
  IngestionJobSchema,
  SourceDocumentSchema,
  asGameId,
  asSourceDocumentId,
  type Game,
  type IngestionJob,
  type SourceDocument,
} from '@bgr/domain';
import { InMemoryDocumentsRepository } from '../documents/in-memory-documents-repository.js';
import { InMemoryGamesRepository } from '../games/in-memory-games-repository.js';
import { InMemoryIngestionJobsRepository } from '../ingestion-jobs/in-memory-ingestion-jobs-repository.js';
import { PublishConflictError, type PublishDocumentArgs } from './atomic-publisher.js';
import { InMemoryAtomicPublisher } from './in-memory-atomic-publisher.js';

const iso = '2026-09-17T00:00:00.000Z';
const later = '2026-09-17T00:05:00.000Z';

const game: Game = {
  gameId: asGameId('g_1'),
  slug: 'g',
  name: 'G',
  editions: [
    {
      editionId: 'e_1' as Game['editions'][number]['editionId'],
      gameId: asGameId('g_1'),
      name: 'First',
      knowledgeRevision: 0,
      createdAt: iso,
      updatedAt: iso,
    },
  ],
  createdAt: iso,
  updatedAt: iso,
};

const doc = (documentId: string, status: SourceDocument['status']): SourceDocument =>
  SourceDocumentSchema.parse({
    documentId,
    gameId: 'g_1',
    editionId: 'e_1',
    contentId: 'c_1',
    title: 'Rulebook',
    sourceType: 'RULEBOOK',
    authority: 'OFFICIAL_RULES',
    origin: 'UPLOAD',
    contentHash: documentId.padEnd(64, 'x').slice(0, 64),
    rawObjectUri: 's3://b/raw/x.pdf',
    chunkCount: 3,
    status,
    knowledgeRevision: 1,
    createdAt: iso,
    updatedAt: iso,
  });

const job = (jobId: string, status: IngestionJob['status']): IngestionJob =>
  IngestionJobSchema.parse({
    jobId,
    gameId: 'g_1',
    editionId: 'e_1',
    contentId: 'c_1',
    title: 'Rulebook',
    sourceType: 'RULEBOOK',
    authority: 'OFFICIAL_RULES',
    source: { kind: 'S3', s3Key: 'raw/x.pdf', contentType: 'application/pdf' },
    status,
    stage: 'FINALIZE',
    completedStages: [],
    createdAt: iso,
    updatedAt: iso,
  });

async function setup() {
  const documents = new InMemoryDocumentsRepository();
  const games = new InMemoryGamesRepository();
  const jobs = new InMemoryIngestionJobsRepository();
  await games.createGame(game);
  const publisher = new InMemoryAtomicPublisher(documents, games, jobs);
  const argsFor = (documentId: string, jobId: string): PublishDocumentArgs => ({
    newDocument: { ...doc(documentId, 'CURRENT'), updatedAt: later },
    gameId: game.gameId,
    nextEditions: [{ ...game.editions[0]!, knowledgeRevision: 1, updatedAt: later }],
    expectedGameUpdatedAt: iso,
    completedJob: { ...job(jobId, 'SUCCEEDED'), updatedAt: later },
    expectedJobUpdatedAt: iso,
    now: later,
  });
  return { documents, games, jobs, publisher, argsFor };
}

describe('InMemoryAtomicPublisher', () => {
  it('lets only one of two concurrent publishes commit', async () => {
    const { documents, jobs, publisher, argsFor } = await setup();
    await jobs.createJob(job('job_a', 'RUNNING'));
    await jobs.createJob(job('job_b', 'RUNNING'));

    const results = await Promise.allSettled([
      publisher.publishDocument(argsFor('doc_a', 'job_a')),
      publisher.publishDocument(argsFor('doc_b', 'job_b')),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((rejected.reason as PublishConflictError).reason).toBe('GAME_STALE');
    const current = (
      await documents.listDocumentsForEdition(game.gameId, game.editions[0]!.editionId)
    ).filter((d) => d.status === 'CURRENT');
    expect(current).toHaveLength(1);
  });

  it('reinstates a SUPERSEDED document and supersedes the CURRENT one', async () => {
    const { documents, jobs, publisher, argsFor } = await setup();
    await documents.createDocument(doc('doc_v1', 'SUPERSEDED'));
    await documents.createDocument(doc('doc_v2', 'CURRENT'));
    await jobs.createJob(job('job_r', 'RUNNING'));

    await publisher.publishDocument({
      ...argsFor('doc_v1', 'job_r'),
      reinstate: true,
      supersedeDocumentId: asSourceDocumentId('doc_v2'),
    });

    expect((await documents.getDocument(asSourceDocumentId('doc_v1')))?.status).toBe('CURRENT');
    expect((await documents.getDocument(asSourceDocumentId('doc_v2')))?.status).toBe('SUPERSEDED');
  });

  it('rejects a transaction that touches the same document twice, like DynamoDB (not a conflict)', async () => {
    const { documents, jobs, publisher, argsFor } = await setup();
    await documents.createDocument(doc('doc_v1', 'SUPERSEDED'));
    await jobs.createJob(job('job_r', 'RUNNING'));

    const err = await publisher
      .publishDocument({
        ...argsFor('doc_v1', 'job_r'),
        reinstate: true,
        supersedeDocumentId: asSourceDocumentId('doc_v1'),
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PublishConflictError);
    expect((err as Error).name).toBe('ValidationException');
  });

  it('refuses to reinstate a document that is not SUPERSEDED', async () => {
    const { documents, jobs, publisher, argsFor } = await setup();
    await documents.createDocument(doc('doc_v1', 'CURRENT'));
    await jobs.createJob(job('job_r', 'RUNNING'));

    const err = await publisher
      .publishDocument({ ...argsFor('doc_v1', 'job_r'), reinstate: true })
      .catch((e: unknown) => e);
    expect((err as PublishConflictError).reason).toBe('DOC_NOT_SUPERSEDED');
  });
});
