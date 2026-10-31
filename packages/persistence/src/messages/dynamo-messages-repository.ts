import { MessageSchema, type Message, type SessionId } from '@bgr/domain';
import { ConditionalCheckFailedException, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  MessageIndexTakenError,
  type ListMessagesOptions,
  type MessagesRepository,
} from './messages-repository.js';

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
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tables.messagesTable,
          Item: message,
          // The key is (sessionId, index): this fails if that exact item already exists.
          ConditionExpression: 'attribute_not_exists(sessionId)',
        }),
      );
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        throw new MessageIndexTakenError(message.sessionId, message.index);
      }
      throw err;
    }
  }

  async listMessages(sessionId: SessionId, options: ListMessagesOptions = {}): Promise<Message[]> {
    const res = await this.doc.send(
      new QueryCommand({
        TableName: this.tables.messagesTable,
        KeyConditionExpression: 'sessionId = :s',
        ExpressionAttributeValues: { ':s': sessionId },
        ...(options.consistentRead ? { ConsistentRead: true } : {}),
      }),
    );
    return (res.Items ?? []).map((i) => MessageSchema.parse(i));
  }
}
