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

  describe('markFailedIfActive', () => {
    const error = { stage: 'PARSE' as const, message: 'boom', code: 'X' };
    const later = '2026-09-17T00:05:00.000Z';

    it('marks a RUNNING job FAILED with the error', async () => {
      const repo = new InMemoryIngestionJobsRepository();
      await repo.createJob(makeJob({ status: 'RUNNING', stage: 'PARSE' }));
      expect(await repo.markFailedIfActive(asIngestionJobId('job_1'), error, later)).toBe('FAILED');
      const job = await repo.getJob(asIngestionJobId('job_1'));
      expect(job).toMatchObject({ status: 'FAILED', stage: 'PARSE', error, updatedAt: later });
    });

    it.each(['SUCCEEDED', 'FAILED'] as const)('leaves a %s job untouched', async (status) => {
      const repo = new InMemoryIngestionJobsRepository();
      const prior = { stage: 'CHUNK' as const, message: 'earlier', code: 'EARLIER' };
      await repo.createJob(
        makeJob({ status, stage: 'CHUNK', ...(status === 'FAILED' ? { error: prior } : {}) }),
      );
      expect(await repo.markFailedIfActive(asIngestionJobId('job_1'), error, later)).toBe(
        'NOT_APPLIED',
      );
      const job = await repo.getJob(asIngestionJobId('job_1'));
      expect(job?.status).toBe(status);
      expect(job?.updatedAt).toBe(iso);
      expect(job?.error).toEqual(status === 'FAILED' ? prior : undefined);
    });
  });
});
