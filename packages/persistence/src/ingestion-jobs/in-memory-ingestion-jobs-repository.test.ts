import { describe, expect, it } from 'vitest';
import {
  asContentId,
  asEditionId,
  asGameId,
  asIngestionJobId,
  type IngestionJob,
} from '@bgr/domain';
import { InMemoryIngestionJobsRepository } from './in-memory-ingestion-jobs-repository.js';

const iso = '2026-09-17T00:00:00.000Z';

const makeJob = (over: Partial<IngestionJob> = {}): IngestionJob => ({
  jobId: asIngestionJobId('job_1'),
  gameId: asGameId('g_ti4'),
  editionId: asEditionId('e_1'),
  contentId: asContentId('c_base'),
  title: 'Base Rulebook',
  sourceType: 'RULEBOOK',
  authority: 'OFFICIAL_RULES',
  source: { kind: 'S3', s3Key: 'raw/2026-09-17/abc.pdf', contentType: 'application/pdf' },
  status: 'PENDING',
  stage: 'VALIDATE',
  completedStages: [],
  createdAt: iso,
  updatedAt: iso,
  ...over,
});

describe('InMemoryIngestionJobsRepository', () => {
  it('createJob + getJob roundtrips', async () => {
    const repo = new InMemoryIngestionJobsRepository();
    const job = makeJob();
    await repo.createJob(job);
    expect((await repo.getJob(job.jobId))?.stage).toBe('VALIDATE');
  });

  it('updateJob merges patch and re-validates', async () => {
    const repo = new InMemoryIngestionJobsRepository();
    await repo.createJob(makeJob());
    const merged = await repo.updateJob(
      asIngestionJobId('job_1'),
      { status: 'RUNNING', stage: 'FETCH', completedStages: ['VALIDATE'] },
      '2026-09-17T00:00:01.000Z',
    );
    expect(merged.status).toBe('RUNNING');
    expect(merged.stage).toBe('FETCH');
    expect(merged.completedStages).toEqual(['VALIDATE']);
    expect(merged.updatedAt).toBe('2026-09-17T00:00:01.000Z');
  });

  it('updateJob throws when the job is absent', async () => {
    const repo = new InMemoryIngestionJobsRepository();
    await expect(
      repo.updateJob(asIngestionJobId('job_missing'), { status: 'FAILED' }, iso),
    ).rejects.toThrow(/not found/);
  });
});
