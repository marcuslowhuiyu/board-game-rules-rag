import { MessageSchema, type Message, type SessionId } from '@bgr/domain';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { MessagesRepository } from './messages-repository.js';

export interface DynamoMessagesTables {
  messagesTable: string;
}

export class DynamoMessagesRepository implements MessagesRepository {
  private readonly doc: DynamoDBDocumentClient;

  constructor(
    client: DynamoDBClient,
    private readonly tables: DynamoMessagesTables,
  ) {
    this.doc = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true },
    });
  }

  async appendMessage(message: Message): Promise<void> {
    await this.doc.send(new PutCommand({ TableName: this.tables.messagesTable, Item: message }));
  }

  async listMessages(sessionId: SessionId): Promise<Message[]> {
    const res = await this.doc.send(
      new QueryCommand({
        TableName: this.tables.messagesTable,
        KeyConditionExpression: 'sessionId = :s',
        ExpressionAttributeValues: { ':s': sessionId },
      }),
    );
    return (res.Items ?? []).map((i) => MessageSchema.parse(i));
  }
}
