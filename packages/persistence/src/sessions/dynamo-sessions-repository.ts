import { SessionSchema, type Session, type SessionId } from '@bgr/domain';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { SessionsRepository } from './sessions-repository.js';

export interface DynamoSessionsTables {
  sessionsTable: string;
}

export class DynamoSessionsRepository implements SessionsRepository {
  private readonly doc: DynamoDBDocumentClient;

  constructor(
    client: DynamoDBClient,
    private readonly tables: DynamoSessionsTables,
  ) {
    this.doc = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true },
    });
  }

  async createSession(session: Session): Promise<Session> {
    await this.doc.send(new PutCommand({ TableName: this.tables.sessionsTable, Item: session }));
    return session;
  }

  async getSession(sessionId: SessionId): Promise<Session | null> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.tables.sessionsTable, Key: { sessionId } }),
    );
    if (!res.Item) return null;
    const session = SessionSchema.parse(res.Item);
    // DynamoDB TTL sweeps are eventually consistent; enforce here too.
    if (session.ttl * 1000 <= Date.now()) return null;
    return session;
  }

  async touch(
    sessionId: SessionId,
    updatedAt: string,
    expiresAt: string,
    ttl: number,
  ): Promise<void> {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tables.sessionsTable,
        Key: { sessionId },
        UpdateExpression: 'SET updatedAt = :u, expiresAt = :e, #ttl = :ttl',
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: {
          ':u': updatedAt,
          ':e': expiresAt,
          ':ttl': ttl,
        },
        ConditionExpression: 'attribute_exists(sessionId)',
      }),
    );
  }

  async deleteSession(sessionId: SessionId): Promise<void> {
    await this.doc.send(
      new DeleteCommand({ TableName: this.tables.sessionsTable, Key: { sessionId } }),
    );
  }
}
