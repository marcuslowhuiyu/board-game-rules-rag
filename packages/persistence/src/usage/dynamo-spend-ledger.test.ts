import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoSpendLedger } from './dynamo-spend-ledger.js';

// 2026-10-30T00:00:00Z
const DAY_START_EPOCH = Date.UTC(2026, 9, 30) / 1000;
const EIGHT_DAYS = 8 * 24 * 60 * 60;

describe('DynamoSpendLedger.add', () => {
  const docMock = mockClient(DynamoDBDocumentClient);
  const ledger = new DynamoSpendLedger(new DynamoDBClient({}), { usageTable: 'usage' });

  beforeEach(() => {
    docMock.reset();
    docMock.on(UpdateCommand).resolves({});
  });

  it('adds atomically to the day item with ADD and sets a TTL 8 days after the day starts', async () => {
    await ledger.add('2026-10-30', 0.25);

    const input = docMock.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(input.TableName).toBe('usage');
    expect(input.Key).toEqual({ pk: 'ai-spend#2026-10-30' });
    expect(input.UpdateExpression).toBe('ADD usd :u SET #ttl = :ttl');
    expect(input.ExpressionAttributeNames).toEqual({ '#ttl': 'ttl' });
    expect(input.ExpressionAttributeValues).toEqual({
      ':u': 0.25,
      ':ttl': DAY_START_EPOCH + EIGHT_DAYS,
    });
  });

  it('rejects a negative amount without writing', async () => {
    await expect(ledger.add('2026-10-30', -0.01)).rejects.toThrow(/usd/);
    expect(docMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects a non-finite amount (%s) without writing',
    async (usd) => {
      await expect(ledger.add('2026-10-30', usd)).rejects.toThrow(/usd/);
      expect(docMock.commandCalls(UpdateCommand)).toHaveLength(0);
    },
  );

  it('rejects a malformed day without writing', async () => {
    await expect(ledger.add('30-10-2026', 0.1)).rejects.toThrow(/day/);
    expect(docMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });
});

describe('DynamoSpendLedger.spentUsd', () => {
  const docMock = mockClient(DynamoDBDocumentClient);
  const ledger = new DynamoSpendLedger(new DynamoDBClient({}), { usageTable: 'usage' });

  beforeEach(() => {
    docMock.reset();
  });

  it('reads the day item with strong consistency', async () => {
    docMock.on(GetCommand).resolves({ Item: { pk: 'ai-spend#2026-10-30', usd: 0.5 } });
    expect(await ledger.spentUsd('2026-10-30')).toBe(0.5);

    const input = docMock.commandCalls(GetCommand)[0]!.args[0].input;
    expect(input.TableName).toBe('usage');
    expect(input.Key).toEqual({ pk: 'ai-spend#2026-10-30' });
    expect(input.ConsistentRead).toBe(true);
  });

  it('returns 0 for a day with no item', async () => {
    docMock.on(GetCommand).resolves({});
    expect(await ledger.spentUsd('2026-10-31')).toBe(0);
  });
});
