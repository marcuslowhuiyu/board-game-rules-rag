import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  asChunkId,
  asContentId,
  asEditionId,
  asGameId,
  asSourceDocumentId,
  type Chunk,
} from '@bgr/domain';
import { DynamoChunksRepository } from './dynamo-chunks-repository.js';

const iso = '2026-09-17T00:00:00.000Z';

const makeChunk = (ordinal: number): Chunk => ({
  chunkId: asChunkId(`ch_${ordinal.toString().padStart(4, '0')}`),
  documentId: asSourceDocumentId('doc_1'),
  gameId: asGameId('g_1'),
  editionId: asEditionId('e_1'),
  contentId: asContentId('c_1'),
  ordinal,
  headingPath: ['Section'],
  pageStart: 1,
  pageEnd: 1,
  textUri: 's3://b/normalized/doc_1/x.txt',
  textPreview: 'x',
  charCount: 1,
  tokenCount: 1,
  authority: 'OFFICIAL_RULES',
  sourceType: 'RULEBOOK',
  isCurrent: true,
  createdAt: iso,
});

describe('DynamoChunksRepository.putChunks', () => {
  const docMock = mockClient(DynamoDBDocumentClient);

  beforeEach(() => docMock.reset());

  const makeRepo = (attempts = 4) =>
    new DynamoChunksRepository(
      new DynamoDBClient({}),
      { chunksTable: 'chunks' },
      {
        sleep: async () => {},
        jitter: () => 0,
        maxAttempts: attempts,
      },
    );

  it('retries UnprocessedItems until they clear', async () => {
    const chunk = makeChunk(0);
    docMock
      .on(BatchWriteCommand)
      .resolvesOnce({
        UnprocessedItems: { chunks: [{ PutRequest: { Item: chunk } }] },
      })
      .resolvesOnce({
        UnprocessedItems: { chunks: [{ PutRequest: { Item: chunk } }] },
      })
      .resolves({ UnprocessedItems: {} });

    await makeRepo().putChunks([chunk]);
    expect(docMock.commandCalls(BatchWriteCommand)).toHaveLength(3);
  });

  it('throws when UnprocessedItems remain after maxAttempts', async () => {
    const chunk = makeChunk(0);
    docMock.on(BatchWriteCommand).resolves({
      UnprocessedItems: { chunks: [{ PutRequest: { Item: chunk } }] },
    });
    await expect(makeRepo(3).putChunks([chunk])).rejects.toThrow(/unprocessed/i);
  });

  it('splits > 25 chunks into multiple batches', async () => {
    const chunks = Array.from({ length: 30 }, (_, i) => makeChunk(i));
    docMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
    await makeRepo().putChunks(chunks);
    // 30 / 25 = 2 batches.
    expect(docMock.commandCalls(BatchWriteCommand)).toHaveLength(2);
  });
});
