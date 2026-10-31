import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { asMessageId, asSessionId, type Message } from '@bgr/domain';
import { DynamoMessagesRepository } from './dynamo-messages-repository.js';
import { MessageIndexTakenError } from './messages-repository.js';

const message: Message = {
  messageId: asMessageId('m_1'),
  sessionId: asSessionId('s_abc'),
  index: 0,
  role: 'USER',
  content: 'May I attack twice?',
  createdAt: '2026-09-16T00:00:00.000Z',
};

describe('DynamoMessagesRepository', () => {
  const docMock = mockClient(DynamoDBDocumentClient);
  beforeEach(() => docMock.reset());

  const makeRepo = () =>
    new DynamoMessagesRepository(new DynamoDBClient({}), { messagesTable: 'messages' });

  it('appendMessage puts only if the (sessionId, index) key is free', async () => {
    docMock.on(PutCommand).resolves({});
    await makeRepo().appendMessage(message);
    const input = docMock.commandCalls(PutCommand)[0]!.args[0].input;
    expect(input.Item).toEqual(message);
    // On a composite key this fails when an item with the same (sessionId, index) exists.
    expect(input.ConditionExpression).toBe('attribute_not_exists(sessionId)');
  });

  it('appendMessage maps a failed condition to MessageIndexTakenError', async () => {
    docMock
      .on(PutCommand)
      .rejects(new ConditionalCheckFailedException({ message: 'taken', $metadata: {} }));
    await expect(makeRepo().appendMessage(message)).rejects.toBeInstanceOf(MessageIndexTakenError);
  });

  it('appendMessage lets other errors through', async () => {
    docMock.on(PutCommand).rejects(new Error('throttled'));
    await expect(makeRepo().appendMessage(message)).rejects.toThrow('throttled');
  });

  it('listMessages reads eventually consistent by default', async () => {
    docMock.on(QueryCommand).resolves({ Items: [message] });
    expect(await makeRepo().listMessages(message.sessionId)).toEqual([message]);
    expect(docMock.commandCalls(QueryCommand)[0]!.args[0].input.ConsistentRead).toBeUndefined();
  });

  it('listMessages can read consistently', async () => {
    docMock.on(QueryCommand).resolves({ Items: [message] });
    await makeRepo().listMessages(message.sessionId, { consistentRead: true });
    expect(docMock.commandCalls(QueryCommand)[0]!.args[0].input.ConsistentRead).toBe(true);
  });
});
