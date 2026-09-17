import {
  ConflictError,
  IngestionJobSchema,
  NotFoundError,
  type IngestionJob,
  type IngestionJobId,
} from '@bgr/domain';
import { ConditionalCheckFailedException, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { IngestionJobsRepository } from './ingestion-jobs-repository.js';

export interface DynamoIngestionJobsTables {
  ingestionJobsTable: string;
}

export class DynamoIngestionJobsRepository implements IngestionJobsRepository {
  private readonly doc: DynamoDBDocumentClient;

  constructor(
    client: DynamoDBClient,
    private readonly tables: DynamoIngestionJobsTables,
  ) {
    this.doc = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true },
    });
  }

  async createJob(job: IngestionJob): Promise<void> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tables.ingestionJobsTable,
          Item: job,
          ConditionExpression: 'attribute_not_exists(jobId)',
        }),
      );
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        throw new ConflictError(`ingestion job already exists: ${job.jobId}`);
      }
      throw err;
    }
  }

  async getJob(jobId: IngestionJobId): Promise<IngestionJob | null> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.tables.ingestionJobsTable, Key: { jobId } }),
    );
    if (!res.Item) return null;
    return IngestionJobSchema.parse(res.Item);
  }

  async updateJob(
    jobId: IngestionJobId,
    patch: Partial<Omit<IngestionJob, 'jobId' | 'createdAt'>>,
    updatedAt: string,
  ): Promise<IngestionJob> {
    // Read-modify-write is fine at M2 scale — each job has a single writer
    // (the Step Functions execution). If two stages race, the second one's
    // conditional-check on updatedAt will fail and it'll retry.
    const current = await this.getJob(jobId);
    if (!current) throw new NotFoundError('ingestionJob', jobId);
    const merged = IngestionJobSchema.parse({ ...current, ...patch, updatedAt });

    const set: string[] = [];
    const values: Record<string, unknown> = {
      ':expectedUpdatedAt': current.updatedAt,
    };
    const names: Record<string, string> = {};
    let i = 0;
    for (const [k, v] of Object.entries(merged)) {
      if (k === 'jobId' || k === 'createdAt') continue;
      if (v === undefined) continue;
      const alias = `:v${i}`;
      const nameAlias = `#k${i}`;
      set.push(`${nameAlias} = ${alias}`);
      values[alias] = v;
      names[nameAlias] = k;
      i++;
    }
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tables.ingestionJobsTable,
          Key: { jobId },
          UpdateExpression: `SET ${set.join(', ')}`,
          ExpressionAttributeValues: values,
          ExpressionAttributeNames: names,
          ConditionExpression: 'updatedAt = :expectedUpdatedAt',
        }),
      );
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        throw new ConflictError(`ingestion job updated concurrently: ${jobId}`);
      }
      throw err;
    }
    return merged;
  }
}
