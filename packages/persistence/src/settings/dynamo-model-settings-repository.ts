import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  SETTINGS_ROLES,
  assertSettingsRole,
  type ModelChoices,
  type ModelSettingsRepository,
  type SettingsRole,
} from './model-settings-repository.js';

export interface DynamoModelSettingsTables {
  usageTable: string;
}

/** Spend rows are keyed by a date, so this key cannot collide with them. */
const SETTINGS_KEY = 'settings#models';

/** The model choices: one item in the usage table, with no TTL so it never expires. */
export class DynamoModelSettingsRepository implements ModelSettingsRepository {
  private readonly doc: DynamoDBDocumentClient;

  constructor(
    client: DynamoDBClient,
    private readonly tables: DynamoModelSettingsTables,
  ) {
    this.doc = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true },
    });
  }

  async getModelChoices(): Promise<ModelChoices> {
    const res = await this.doc.send(
      new GetCommand({
        TableName: this.tables.usageTable,
        Key: { pk: SETTINGS_KEY },
        ConsistentRead: true,
      }),
    );
    const choices: ModelChoices = {};
    for (const role of SETTINGS_ROLES) {
      const value = res.Item?.[role];
      if (typeof value === 'string' && value.length > 0) choices[role] = value;
    }
    return choices;
  }

  async setModelChoice(role: SettingsRole, key: string, updatedAt: string): Promise<void> {
    assertSettingsRole(role);
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tables.usageTable,
        Key: { pk: SETTINGS_KEY },
        UpdateExpression: 'SET #role = :key, updatedAt = :at',
        ExpressionAttributeNames: { '#role': role },
        ExpressionAttributeValues: { ':key': key, ':at': updatedAt },
      }),
    );
  }
}
