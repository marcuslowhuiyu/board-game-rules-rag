import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { asContentId, asEditionId, asGameId, asSourceDocumentId } from '@bgr/domain';
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
