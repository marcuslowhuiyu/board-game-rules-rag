import { ChunkSchema, type Chunk, type SourceDocumentId } from '@bgr/domain';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { ChunksRepository } from './chunks-repository.js';

export interface DynamoChunksTables {
  chunksTable: string;
}

const DDB_MAX_BATCH = 25;

function chunkArray<T>(input: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < input.length; i += size) {
    out.push(input.slice(i, i + size));
  }
  return out;
}

export class DynamoChunksRepository implements ChunksRepository {
  private readonly doc: DynamoDBDocumentClient;

  constructor(
    client: DynamoDBClient,
    private readonly tables: DynamoChunksTables,
  ) {
    this.doc = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true },
    });
  }

  async putChunks(chunks: Chunk[]): Promise<void> {
    for (const batch of chunkArray(chunks, DDB_MAX_BATCH)) {
      await this.doc.send(
        new BatchWriteCommand({
          RequestItems: {
            [this.tables.chunksTable]: batch.map((c) => ({ PutRequest: { Item: c } })),
          },
        }),
      );
    }
  }

  async listChunksForDocument(documentId: SourceDocumentId): Promise<Chunk[]> {
    const res = await this.doc.send(
      new QueryCommand({
        TableName: this.tables.chunksTable,
        KeyConditionExpression: 'documentId = :d',
        ExpressionAttributeValues: { ':d': documentId },
      }),
    );
    const items = (res.Items ?? []).map((i) => ChunkSchema.parse(i));
    return items.sort((a, b) => a.ordinal - b.ordinal);
  }

  async deleteChunksForDocument(documentId: SourceDocumentId): Promise<void> {
    const res = await this.doc.send(
      new QueryCommand({
        TableName: this.tables.chunksTable,
        KeyConditionExpression: 'documentId = :d',
        ExpressionAttributeValues: { ':d': documentId },
        ProjectionExpression: 'documentId, chunkId',
      }),
    );
    const keys = (res.Items ?? []).map((i) => ({
      documentId: i['documentId'] as string,
      chunkId: i['chunkId'] as string,
    }));
    for (const batch of chunkArray(keys, DDB_MAX_BATCH)) {
      await this.doc.send(
        new BatchWriteCommand({
          RequestItems: {
            [this.tables.chunksTable]: batch.map((k) => ({ DeleteRequest: { Key: k } })),
          },
        }),
      );
    }
  }
}
