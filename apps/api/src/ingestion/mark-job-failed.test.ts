import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asIngestionJobId, type IngestionJob } from '@bgr/domain';
import { InMemoryIngestionJobsRepository } from '@bgr/persistence';
import { handler, overrideRepoForTests, resetRepoForTests } from './mark-job-failed.js';
import { seedJob } from './pipeline.js';

const LATER = '2026-09-17T00:05:00.000Z';

describe('MarkJobFailed handler', () => {
  let repo: InMemoryIngestionJobsRepository;

  beforeEach(() => {
    repo = new InMemoryIngestionJobsRepository();
    overrideRepoForTests(repo);
  });
  afterEach(() => resetRepoForTests());

  async function seed(overrides: Partial<IngestionJob>): Promise<void> {
    await repo.createJob(seedJob({ jobId: asIngestionJobId('job_1'), ...overrides }));
  }

  it('marks a RUNNING job FAILED with the caught error details', async () => {
    await seed({ status: 'RUNNING', stage: 'PARSE' });
    const out = await handler({
      jobId: 'job_1',
      stage: 'PARSE',
      cause: 'Task timed out',
      errorName: 'States.Timeout',
    });
    expect(out.status).toBe('FAILED');
    const job = await repo.getJob(asIngestionJobId('job_1'));
    expect(job?.status).toBe('FAILED');
    expect(job?.error).toEqual({
      stage: 'PARSE',
      message: 'Task timed out',
      code: 'States.Timeout',
    });
  });

  it('keeps the more specific error on an already-FAILED job', async () => {
    await seed({
      status: 'FAILED',
      stage: 'PARSE',
      error: { stage: 'PARSE', message: 'likely scan', code: 'LIKELY_SCAN' },
    });
    await handler({ jobId: 'job_1', stage: 'PARSE', cause: 'x', errorName: 'StageError' });
    const job = await repo.getJob(asIngestionJobId('job_1'));
    expect(job?.error?.code).toBe('LIKELY_SCAN');
  });

  it('never downgrades a SUCCEEDED job to FAILED', async () => {
    await seed({ status: 'SUCCEEDED', stage: 'FINALIZE', updatedAt: LATER });
    const out = await handler({
      jobId: 'job_1',
      stage: 'FINALIZE',
      cause: 'Task timed out',
      errorName: 'States.Timeout',
    });
    expect(out.status).toBe('SUCCEEDED');
    const job = await repo.getJob(asIngestionJobId('job_1'));
    expect(job?.status).toBe('SUCCEEDED');
    expect(job?.error).toBeUndefined();
    expect(job?.updatedAt).toBe(LATER);
  });
});
