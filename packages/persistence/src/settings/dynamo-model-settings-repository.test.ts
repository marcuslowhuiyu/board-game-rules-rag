import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoModelSettingsRepository } from './dynamo-model-settings-repository.js';

const T = '2026-11-24T00:00:00.000Z';

describe('DynamoModelSettingsRepository', () => {
  const docMock = mockClient(DynamoDBDocumentClient);
  const repo = new DynamoModelSettingsRepository(new DynamoDBClient({}), { usageTable: 'usage' });

  beforeEach(() => {
    docMock.reset();
  });

  it('reads the settings item with a strongly consistent read', async () => {
    docMock.on(GetCommand).resolves({
      Item: { pk: 'settings#models', answerer: 'claude-haiku-5-5', updatedAt: T },
    });
    expect(await repo.getModelChoices()).toEqual({ answerer: 'claude-haiku-5-5' });
    const input = docMock.commandCalls(GetCommand)[0]!.args[0].input;
    expect(input.TableName).toBe('usage');
    expect(input.Key).toEqual({ pk: 'settings#models' });
    expect(input.ConsistentRead).toBe(true);
  });

  it('returns {} when the item does not exist', async () => {
    docMock.on(GetCommand).resolves({});
    expect(await repo.getModelChoices()).toEqual({});
  });

  it('ignores attributes that are not a non-empty string', async () => {
    docMock.on(GetCommand).resolves({ Item: { pk: 'settings#models', router: 5, reranker: '' } });
    expect(await repo.getModelChoices()).toEqual({});
  });

  it('writes one role with SET and no ttl', async () => {
    docMock.on(UpdateCommand).resolves({});
    await repo.setModelChoice('answerer', 'claude-haiku-5-5', T);
    const input = docMock.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(input.TableName).toBe('usage');
    expect(input.Key).toEqual({ pk: 'settings#models' });
    expect(input.UpdateExpression).toBe('SET #role = :key, updatedAt = :at');
    expect(input.ExpressionAttributeNames).toEqual({ '#role': 'answerer' });
    expect(input.ExpressionAttributeValues).toEqual({ ':key': 'claude-haiku-5-5', ':at': T });
  });

  it('rejects an unknown role without writing', async () => {
    await expect(repo.setModelChoice('judge' as never, 'x', T)).rejects.toThrow(/role/);
    expect(docMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });
});
