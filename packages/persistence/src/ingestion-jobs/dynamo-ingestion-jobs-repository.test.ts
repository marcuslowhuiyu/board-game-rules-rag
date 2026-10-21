import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { asIngestionJobId } from '@bgr/domain';
import { DynamoIngestionJobsRepository } from './dynamo-ingestion-jobs-repository.js';

// No real DynamoDB in unit tests: these assert the request each method sends,
// which is the contract DynamoDB enforces (consistency, conditions).
describe('DynamoIngestionJobsRepository', () => {
  const docMock = mockClient(DynamoDBDocumentClient);
  const repo = new DynamoIngestionJobsRepository(new DynamoDBClient({}), {
    ingestionJobsTable: 'jobs',
  });
  const jobId = asIngestionJobId('job_1');

  beforeEach(() => docMock.reset());

  it('reads jobs with strong consistency (stages consume the previous stage’s write)', async () => {
    docMock.on(GetCommand).resolves({});
    await repo.getJob(jobId);
    expect(docMock.commandCalls(GetCommand)[0]!.args[0].input.ConsistentRead).toBe(true);
  });

  describe('markFailedIfActive', () => {
    const error = { stage: 'PARSE' as const, message: 'boom', code: 'X' };
    const at = '2026-09-17T00:05:00.000Z';

    it('writes FAILED in one conditional update that excludes terminal jobs', async () => {
      docMock.on(UpdateCommand).resolves({});
      expect(await repo.markFailedIfActive(jobId, error, at)).toBe('FAILED');

      expect(docMock.commandCalls(GetCommand)).toHaveLength(0); // no read-then-write
      const input = docMock.commandCalls(UpdateCommand)[0]!.args[0].input;
      const values = Object.values(input.ExpressionAttributeValues ?? {});
      expect(values).toEqual(expect.arrayContaining(['FAILED', 'SUCCEEDED', error, at]));
      // The condition must name both terminal statuses so DynamoDB refuses
      // the write for either.
      const terminalAliases = Object.entries(input.ExpressionAttributeValues ?? {})
        .filter(([, v]) => v === 'SUCCEEDED' || v === 'FAILED')
        .map(([k]) => k);
      for (const alias of terminalAliases.filter((a) => input.ConditionExpression!.includes(a))) {
        expect(input.ConditionExpression).toContain(`<> ${alias}`);
      }
      expect(input.ConditionExpression).toMatch(/attribute_exists\(jobId\)/);
      expect(
        terminalAliases.filter((a) => input.ConditionExpression!.includes(`<> ${a}`)),
      ).toHaveLength(2);
    });

    it('reports NOT_APPLIED when DynamoDB rejects the condition (job already terminal)', async () => {
      docMock
        .on(UpdateCommand)
        .rejects(new ConditionalCheckFailedException({ message: 'no', $metadata: {} }));
      expect(await repo.markFailedIfActive(jobId, error, at)).toBe('NOT_APPLIED');
    });
  });
});
