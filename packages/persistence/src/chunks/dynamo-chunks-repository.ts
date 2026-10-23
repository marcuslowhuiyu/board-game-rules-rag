import { ChunkSchema, type Chunk, type SourceDocumentId } from '@bgr/domain';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  QueryCommand,
  type BatchWriteCommandInput,
  type QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';
import type { ChunksRepository } from './chunks-repository.js';

export interface DynamoChunksTables {
  chunksTable: string;
}

const DDB_MAX_BATCH = 25;
const MAX_ATTEMPTS = 6;

function chunkArray<T>(input: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < input.length; i += size) {
    out.push(input.slice(i, i + size));
  }
  return out;
}

type WriteRequest = NonNullable<
  NonNullable<BatchWriteCommandInput['RequestItems']>[string]
>[number];

export interface BatchRetryOptions {
  /** Injectable sleep for tests. Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable jitter [0,1). Defaults to Math.random. */
  jitter?: () => number;
  /** Maximum backoff attempts. Defaults to 6 (up to ~6.4 s). */
  maxAttempts?: number;
}

export class DynamoChunksRepository implements ChunksRepository {
  private readonly doc: DynamoDBDocumentClient;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly jitter: () => number;
  private readonly maxAttempts: number;

  constructor(
    client: DynamoDBClient,
    private readonly tables: DynamoChunksTables,
    options: BatchRetryOptions = {},
  ) {
    this.doc = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true },
    });
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.jitter = options.jitter ?? (() => Math.random());
    this.maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
  }

  async putChunks(chunks: Chunk[]): Promise<void> {
    for (const batch of chunkArray(chunks, DDB_MAX_BATCH)) {
      const requests: WriteRequest[] = batch.map((c) => ({ PutRequest: { Item: c } }));
      await this.runBatchWithRetries(requests, chunks.length);
    }
  }

  async listChunksForDocument(documentId: SourceDocumentId): Promise<Chunk[]> {
    // FINALIZE counts the chunks CHUNK just wrote, hence ConsistentRead.
    const items = (await this.queryAllForDocument(documentId, { ConsistentRead: true })).map((i) =>
      ChunkSchema.parse(i),
    );
    return items.sort((a, b) => a.ordinal - b.ordinal);
  }

  async deleteChunksForDocument(documentId: SourceDocumentId): Promise<void> {
    const rows = await this.queryAllForDocument(documentId, {
      ProjectionExpression: 'documentId, chunkId',
    });
    const keys = rows.map((i) => ({
      documentId: i['documentId'] as string,
      chunkId: i['chunkId'] as string,
    }));
    for (const batch of chunkArray(keys, DDB_MAX_BATCH)) {
      const requests: WriteRequest[] = batch.map((k) => ({ DeleteRequest: { Key: k } }));
      await this.runBatchWithRetries(requests, keys.length);
    }
  }

  /**
   * Every item for a document, following `LastEvaluatedKey`: a single Query
   * returns at most 1 MiB, which a large rulebook's chunk metadata exceeds.
   */
  private async queryAllForDocument(
    documentId: SourceDocumentId,
    extra: Partial<Pick<QueryCommandInput, 'ConsistentRead' | 'ProjectionExpression'>>,
  ): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const res = await this.doc.send(
        new QueryCommand({
          TableName: this.tables.chunksTable,
          KeyConditionExpression: 'documentId = :d',
          ExpressionAttributeValues: { ':d': documentId },
          ...extra,
          ...(start ? { ExclusiveStartKey: start } : {}),
        }),
      );
      items.push(...(res.Items ?? []));
      start = res.LastEvaluatedKey;
    } while (start);
    return items;
  }

  /**
   * Send one BatchWrite request and loop over `UnprocessedItems` with capped
   * exponential backoff. Throws if items remain after `maxAttempts` — never
   * silently drops writes (that would let `SourceDocument.chunkCount` claim a
   * number of chunks that aren't actually persisted).
   */
  private async runBatchWithRetries(
    requests: WriteRequest[],
    totalItemsInJob: number,
  ): Promise<void> {
    let pending = requests;
    let attempt = 0;
    while (pending.length > 0) {
      const res = await this.doc.send(
        new BatchWriteCommand({
          RequestItems: { [this.tables.chunksTable]: pending },
        }),
      );
      const unprocessed = (res.UnprocessedItems?.[this.tables.chunksTable] ?? []) as WriteRequest[];
      if (unprocessed.length === 0) return;
      attempt++;
      if (attempt >= this.maxAttempts) {
        throw new Error(
          `BatchWrite left ${unprocessed.length}/${pending.length} items unprocessed after ${attempt} attempts (job total ${totalItemsInJob}); refusing to silently drop writes`,
        );
      }
      // 100ms, 200ms, 400ms, ... (capped at 3.2s) with 0–25% jitter.
      const baseMs = Math.min(100 * 2 ** (attempt - 1), 3200);
      const jitterMs = Math.floor(baseMs * 0.25 * this.jitter());
      await this.sleep(baseMs + jitterMs);
      pending = unprocessed;
    }
  }
}
