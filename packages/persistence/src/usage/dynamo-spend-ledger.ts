import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { assertSpendDay, assertSpendUsd, type SpendLedger } from './spend-ledger.js';

export interface DynamoSpendLedgerTables {
  usageTable: string;
}

const SECONDS_PER_DAY = 24 * 60 * 60;
/** Keep each day's item for 8 days so the day is still readable after it ends. */
const RETENTION_DAYS = 8;

/**
 * Daily AI spend in the usage table: one item per day keyed `ai-spend#YYYY-MM-DD`.
 * `add` is an atomic `ADD`, so concurrent requests cannot lose an update.
 * The TTL is computed in UTC; the day key itself is the caller's Singapore day.
 */
export class DynamoSpendLedger implements SpendLedger {
  private readonly doc: DynamoDBDocumentClient;

  constructor(
    client: DynamoDBClient,
    private readonly tables: DynamoSpendLedgerTables,
  ) {
    this.doc = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true },
    });
  }

  async spentUsd(day: string): Promise<number> {
    assertSpendDay(day);
    const res = await this.doc.send(
      new GetCommand({
        TableName: this.tables.usageTable,
        Key: { pk: spendKey(day) },
        ConsistentRead: true,
      }),
    );
    // A missing item is a day with no spend. A present item with a bad `usd`
    // must not read as 0, or a corrupt record would silently bypass the cap.
    if (!res.Item) return 0;
    const usd = res.Item.usd;
    if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) {
      throw new Error(`corrupt spend item for ${day}`);
    }
    return usd;
  }

  async add(day: string, usd: number): Promise<void> {
    assertSpendDay(day);
    assertSpendUsd(usd);
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tables.usageTable,
        Key: { pk: spendKey(day) },
        UpdateExpression: 'ADD usd :u SET #ttl = :ttl',
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':u': usd, ':ttl': ttlFor(day) },
      }),
    );
  }
}

const spendKey = (day: string): string => `ai-spend#${day}`;

/** Epoch seconds of the start of `day` (UTC) plus the retention window. */
function ttlFor(day: string): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d) / 1000 + RETENTION_DAYS * SECONDS_PER_DAY;
}
