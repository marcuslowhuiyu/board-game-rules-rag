import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  asContentId,
  asEditionId,
  asGameId,
  asSourceDocumentId,
  ConflictError,
  NotFoundError,
  type ProvenanceEvidence,
} from '@bgr/domain';
import { DynamoDocumentsRepository } from './dynamo-documents-repository.js';

// FINALIZE decides what to supersede and whether bytes are duplicates from
// these reads; an eventually consistent miss can leave two CURRENT documents.
describe('DynamoDocumentsRepository reads used by publication', () => {
  const docMock = mockClient(DynamoDBDocumentClient);
  const repo = new DynamoDocumentsRepository(new DynamoDBClient({}), { documentsTable: 'docs' });
  const g = asGameId('g_1');
  const e = asEditionId('e_1');
  const c = asContentId('c_1');

  beforeEach(() => {
    docMock.reset();
    docMock.on(ScanCommand).resolves({ Items: [] });
    docMock.on(GetCommand).resolves({});
  });

  it('findCurrentByKey scans with strong consistency', async () => {
    await repo.findCurrentByKey(g, e, c, 'RULEBOOK');
    expect(docMock.commandCalls(ScanCommand)[0]!.args[0].input.ConsistentRead).toBe(true);
  });

  it('findByContentHash scans with strong consistency', async () => {
    await repo.findByContentHash(g, e, c, 'a'.repeat(64));
    expect(docMock.commandCalls(ScanCommand)[0]!.args[0].input.ConsistentRead).toBe(true);
  });

  it('getDocument reads with strong consistency', async () => {
    await repo.getDocument(asSourceDocumentId('doc_1'));
    expect(docMock.commandCalls(GetCommand)[0]!.args[0].input.ConsistentRead).toBe(true);
  });
});

describe('DynamoDocumentsRepository.setProvenance', () => {
  const docMock = mockClient(DynamoDBDocumentClient);
  const repo = new DynamoDocumentsRepository(new DynamoDBClient({}), { documentsTable: 'docs' });
  const id = asSourceDocumentId('doc_1');
  const provenance: ProvenanceEvidence[] = [{ kind: 'SOURCE_HOST', host: 'example.com' }];
  const expected = '2026-09-17T00:00:00.000Z';
  const next = '2026-10-28T00:00:00.000Z';
  const conditionFailed = (): ConditionalCheckFailedException =>
    new ConditionalCheckFailedException({ message: 'failed', $metadata: {} });

  beforeEach(() => {
    docMock.reset();
  });

  it('updates under an optimistic-concurrency condition', async () => {
    docMock.on(UpdateCommand).resolves({});
    await repo.setProvenance(id, provenance, expected, next);
    const input = docMock.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(input.Key).toEqual({ documentId: id });
    expect(input.ConditionExpression).toBe(
      'attribute_exists(documentId) AND updatedAt = :expected',
    );
    expect(input.ExpressionAttributeValues).toMatchObject({
      ':p': provenance,
      ':u': next,
      ':expected': expected,
    });
    expect(input.UpdateExpression).toBe('SET provenance = :p, updatedAt = :u');
  });

  it('maps a failed condition to ConflictError when the document exists', async () => {
    docMock.on(UpdateCommand).rejects(conditionFailed());
    docMock.on(GetCommand).resolves({
      Item: {
        documentId: id,
        gameId: 'g_1',
        editionId: 'e_1',
        contentId: 'c_1',
        title: 'T',
        sourceType: 'RULEBOOK',
        authority: 'OFFICIAL_RULES',
        origin: 'UPLOAD',
        contentHash: 'a'.repeat(64),
        rawObjectUri: 's3://b/k',
        status: 'CURRENT',
        createdAt: expected,
        updatedAt: '2026-09-18T00:00:00.000Z',
      },
    });
    await expect(repo.setProvenance(id, provenance, expected, next)).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('maps a failed condition to NotFoundError when the document is missing', async () => {
    docMock.on(UpdateCommand).rejects(conditionFailed());
    docMock.on(GetCommand).resolves({});
    await expect(repo.setProvenance(id, provenance, expected, next)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
