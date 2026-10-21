import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  IngestionJobSchema,
  SourceDocumentSchema,
  asGameId,
  asSourceDocumentId,
  type IngestionJob,
  type SourceDocument,
} from '@bgr/domain';
import { DynamoAtomicPublisher } from './dynamo-atomic-publisher.js';
import { PublishConflictError, type PublishDocumentArgs } from './atomic-publisher.js';

const iso = '2026-09-17T00:00:00.000Z';
const later = '2026-09-17T00:05:00.000Z';

const newDocument: SourceDocument = SourceDocumentSchema.parse({
  documentId: 'doc_new',
  gameId: 'g_1',
  editionId: 'e_1',
  contentId: 'c_1',
  title: 'Rulebook',
  sourceType: 'RULEBOOK',
  authority: 'OFFICIAL_RULES',
  origin: 'UPLOAD',
  contentHash: 'a'.repeat(64),
  rawObjectUri: 's3://b/raw/x.pdf',
  chunkCount: 3,
  status: 'CURRENT',
  supersedes: [],
  knowledgeRevision: 1,
  createdAt: later,
  updatedAt: later,
});

const completedJob: IngestionJob = IngestionJobSchema.parse({
  jobId: 'job_1',
  gameId: 'g_1',
  editionId: 'e_1',
  contentId: 'c_1',
  title: 'Rulebook',
  sourceType: 'RULEBOOK',
  authority: 'OFFICIAL_RULES',
  source: { kind: 'S3', s3Key: 'raw/x.pdf', contentType: 'application/pdf' },
  status: 'SUCCEEDED',
  stage: 'FINALIZE',
  completedStages: ['FINALIZE'],
  documentId: 'doc_new',
  chunkCount: 3,
  createdAt: iso,
  updatedAt: later,
});

function args(overrides: Partial<PublishDocumentArgs> = {}): PublishDocumentArgs {
  return {
    newDocument,
    gameId: asGameId('g_1'),
    nextEditions: [],
    expectedGameUpdatedAt: iso,
    completedJob,
    expectedJobUpdatedAt: iso,
    now: later,
    ...overrides,
  };
}

function cancelled(codes: string[]): TransactionCanceledException {
  return new TransactionCanceledException({
    message: 'Transaction cancelled',
    $metadata: {},
    CancellationReasons: codes.map((Code) => ({ Code })),
  });
}

describe('DynamoAtomicPublisher.publishDocument', () => {
  const docMock = mockClient(DynamoDBDocumentClient);
  const publisher = new DynamoAtomicPublisher(new DynamoDBClient({}), {
    documentsTable: 'docs',
    gamesTable: 'games',
    ingestionJobsTable: 'jobs',
  });

  beforeEach(() => docMock.reset());

  it('writes the job SUCCEEDED row in the same transaction as the publish', async () => {
    docMock.on(TransactWriteCommand).resolves({});
    await publisher.publishDocument(args({ supersedeDocumentId: asSourceDocumentId('doc_old') }));

    const calls = docMock.commandCalls(TransactWriteCommand);
    expect(calls).toHaveLength(1);
    const items = calls[0]!.args[0].input.TransactItems!;
    expect(items).toHaveLength(4);
    const jobPut = items[3]!.Put!;
    expect(jobPut.TableName).toBe('jobs');
    expect(jobPut.Item).toMatchObject({ jobId: 'job_1', status: 'SUCCEEDED' });
    expect(jobPut.ConditionExpression).toBe('updatedAt = :expJobUpd');
    expect(jobPut.ExpressionAttributeValues).toEqual({ ':expJobUpd': iso });
  });

  it.each([
    { supersede: false, codes: ['None', 'None', 'ConditionalCheckFailed'] },
    { supersede: true, codes: ['None', 'None', 'None', 'ConditionalCheckFailed'] },
  ])(
    'maps a failed job condition to JOB_STALE (supersede=$supersede)',
    async ({ supersede, codes }) => {
      docMock.on(TransactWriteCommand).rejects(cancelled(codes));
      const err = await publisher
        .publishDocument(
          args(supersede ? { supersedeDocumentId: asSourceDocumentId('doc_old') } : {}),
        )
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PublishConflictError);
      expect((err as PublishConflictError).reason).toBe('JOB_STALE');
    },
  );

  it('still maps the game condition to GAME_STALE with the job item present', async () => {
    docMock.on(TransactWriteCommand).rejects(cancelled(['None', 'ConditionalCheckFailed', 'None']));
    const err = await publisher.publishDocument(args()).catch((e: unknown) => e);
    expect((err as PublishConflictError).reason).toBe('GAME_STALE');
  });
});
