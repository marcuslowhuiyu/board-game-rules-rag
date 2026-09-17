import {
  ConflictError,
  NotFoundError,
  SourceDocumentSchema,
  type ContentId,
  type EditionId,
  type GameId,
  type SourceDocument,
  type SourceDocumentId,
  type SourceType,
} from '@bgr/domain';
import { ConditionalCheckFailedException, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { DocumentsRepository } from './documents-repository.js';

export interface DynamoDocumentsTables {
  documentsTable: string;
}

/**
 * DynamoDB implementation for `SourceDocument`. Uses a single-partition scan
 * with `FilterExpression` for edition-scoped queries (ADR-0008 M2 note): the
 * catalog is small (a handful of documents per edition) and Scan is cheaper
 * to reason about than provisioning a GSI we'd need to migrate later.
 * Upgrade path: add a GSI keyed by `${gameId}#${editionId}` when the doc
 * count per edition grows past a few hundred.
 */
export class DynamoDocumentsRepository implements DocumentsRepository {
  private readonly doc: DynamoDBDocumentClient;

  constructor(
    client: DynamoDBClient,
    private readonly tables: DynamoDocumentsTables,
  ) {
    this.doc = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true },
    });
  }

  async createDocument(doc: SourceDocument): Promise<void> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tables.documentsTable,
          Item: doc,
          ConditionExpression: 'attribute_not_exists(documentId)',
        }),
      );
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        throw new ConflictError(`document already exists: ${doc.documentId}`);
      }
      throw err;
    }
  }

  async getDocument(documentId: SourceDocumentId): Promise<SourceDocument | null> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.tables.documentsTable, Key: { documentId } }),
    );
    if (!res.Item) return null;
    return SourceDocumentSchema.parse(res.Item);
  }

  private async scanFilter(
    filter: string,
    values: Record<string, unknown>,
    names?: Record<string, string>,
  ): Promise<SourceDocument[]> {
    const out: SourceDocument[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const res = await this.doc.send(
        new ScanCommand({
          TableName: this.tables.documentsTable,
          FilterExpression: filter,
          ExpressionAttributeValues: values,
          ...(names ? { ExpressionAttributeNames: names } : {}),
          ...(start ? { ExclusiveStartKey: start } : {}),
        }),
      );
      for (const item of res.Items ?? []) {
        out.push(SourceDocumentSchema.parse(item));
      }
      start = res.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (start);
    return out;
  }

  async listDocumentsForEdition(gameId: GameId, editionId: EditionId): Promise<SourceDocument[]> {
    return this.scanFilter('gameId = :g AND editionId = :e', {
      ':g': gameId,
      ':e': editionId,
    });
  }

  async findByContentHash(
    gameId: GameId,
    editionId: EditionId,
    contentHash: string,
  ): Promise<SourceDocument | null> {
    const items = await this.scanFilter('gameId = :g AND editionId = :e AND contentHash = :h', {
      ':g': gameId,
      ':e': editionId,
      ':h': contentHash,
    });
    return items[0] ?? null;
  }

  async findCurrentByKey(
    gameId: GameId,
    editionId: EditionId,
    contentId: ContentId,
    sourceType: SourceType,
  ): Promise<SourceDocument | null> {
    const items = await this.scanFilter(
      'gameId = :g AND editionId = :e AND contentId = :c AND sourceType = :t AND #s = :curr',
      {
        ':g': gameId,
        ':e': editionId,
        ':c': contentId,
        ':t': sourceType,
        ':curr': 'CURRENT',
      },
      { '#s': 'status' },
    );
    return items[0] ?? null;
  }

  async markSuperseded(documentId: SourceDocumentId, updatedAt: string): Promise<void> {
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tables.documentsTable,
          Key: { documentId },
          UpdateExpression: 'SET #s = :s, updatedAt = :u',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':s': 'SUPERSEDED', ':u': updatedAt },
          ConditionExpression: 'attribute_exists(documentId)',
        }),
      );
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        throw new NotFoundError('sourceDocument', documentId);
      }
      throw err;
    }
  }

  async updateChunkCount(
    documentId: SourceDocumentId,
    chunkCount: number,
    updatedAt: string,
  ): Promise<void> {
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tables.documentsTable,
          Key: { documentId },
          UpdateExpression: 'SET chunkCount = :c, updatedAt = :u',
          ExpressionAttributeValues: { ':c': chunkCount, ':u': updatedAt },
          ConditionExpression: 'attribute_exists(documentId)',
        }),
      );
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        throw new NotFoundError('sourceDocument', documentId);
      }
      throw err;
    }
  }
}
