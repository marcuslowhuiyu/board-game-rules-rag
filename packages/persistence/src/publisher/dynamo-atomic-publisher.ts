import { TransactionCanceledException, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import {
  PublishConflictError,
  type AtomicPublisher,
  type PublishDocumentArgs,
} from './atomic-publisher.js';

export interface DynamoAtomicPublisherTables {
  documentsTable: string;
  gamesTable: string;
  ingestionJobsTable: string;
}

/**
 * DynamoDB `AtomicPublisher` — a single `TransactWriteItems` call that
 * publishes the new document, supersedes the previous CURRENT document,
 * bumps the game edition's `knowledgeRevision`, and marks the ingestion job
 * SUCCEEDED. All-or-nothing.
 *
 * Cancellation reasons are mapped to the typed
 * `PublishConflictError.reason`s so the pipeline can distinguish
 * "someone else already published this" from "game row moved underneath us"
 * and pick the right recovery path.
 */
export class DynamoAtomicPublisher implements AtomicPublisher {
  private readonly doc: DynamoDBDocumentClient;

  constructor(
    client: DynamoDBClient,
    private readonly tables: DynamoAtomicPublisherTables,
  ) {
    this.doc = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true },
    });
  }

  async publishDocument(args: PublishDocumentArgs): Promise<void> {
    const items: NonNullable<TransactWriteCommandInput['TransactItems']> = [];

    items.push({
      Put: {
        TableName: this.tables.documentsTable,
        Item: args.newDocument,
        ConditionExpression: 'attribute_not_exists(documentId)',
      },
    });

    if (args.supersedeDocumentId) {
      items.push({
        Update: {
          TableName: this.tables.documentsTable,
          Key: { documentId: args.supersedeDocumentId },
          UpdateExpression: 'SET #s = :sup, updatedAt = :u',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: {
            ':sup': 'SUPERSEDED',
            ':u': args.now,
            ':curr': 'CURRENT',
          },
          ConditionExpression: 'attribute_exists(documentId) AND #s = :curr',
        },
      });
    }

    items.push({
      Update: {
        TableName: this.tables.gamesTable,
        Key: { gameId: args.gameId },
        UpdateExpression: 'SET editions = :e, updatedAt = :u',
        ExpressionAttributeValues: {
          ':e': args.nextEditions,
          ':u': args.now,
          ':expUpd': args.expectedGameUpdatedAt,
        },
        ConditionExpression: 'updatedAt = :expUpd',
      },
    });

    items.push({
      Put: {
        TableName: this.tables.ingestionJobsTable,
        Item: args.completedJob,
        ExpressionAttributeValues: { ':expJobUpd': args.expectedJobUpdatedAt },
        ConditionExpression: 'updatedAt = :expJobUpd',
      },
    });

    try {
      await this.doc.send(new TransactWriteCommand({ TransactItems: items }));
    } catch (err) {
      if (err instanceof TransactionCanceledException) {
        const reasons = err.CancellationReasons ?? [];
        // Items order: [0]=newDoc put, [1]=supersede (optional), then game
        // update, then job put.
        const offset = args.supersedeDocumentId !== undefined ? 1 : 0;
        const newDocReason = reasons[0];
        const supersedeReason = offset === 1 ? reasons[1] : undefined;
        const gameReason = reasons[1 + offset];
        const jobReason = reasons[2 + offset];
        if (newDocReason?.Code === 'ConditionalCheckFailed') {
          throw new PublishConflictError(
            `document already exists: ${args.newDocument.documentId}`,
            'DOC_EXISTS',
          );
        }
        if (supersedeReason?.Code === 'ConditionalCheckFailed') {
          throw new PublishConflictError(
            `supersede target ${args.supersedeDocumentId} is not CURRENT`,
            'PREV_NOT_CURRENT',
          );
        }
        if (gameReason?.Code === 'ConditionalCheckFailed') {
          throw new PublishConflictError(
            `game ${args.gameId} moved (expected updatedAt ${args.expectedGameUpdatedAt})`,
            'GAME_STALE',
          );
        }
        if (jobReason?.Code === 'ConditionalCheckFailed') {
          throw new PublishConflictError(
            `ingestion job ${args.completedJob.jobId} moved (expected updatedAt ${args.expectedJobUpdatedAt})`,
            'JOB_STALE',
          );
        }
        // Unclassified — surface the raw reasons for observability.
        const summary = reasons.map((r) => r?.Code ?? 'Unknown').join(',');
        throw new PublishConflictError(`transaction cancelled: ${summary}`, 'GAME_STALE');
      }
      throw err;
    }
  }
}
