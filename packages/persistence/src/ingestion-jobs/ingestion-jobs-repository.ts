import type { IngestionJob, IngestionJobId } from '@bgr/domain';

export type IngestionJobError = NonNullable<IngestionJob['error']>;

export interface IngestionJobsRepository {
  createJob(job: IngestionJob): Promise<void>;
  getJob(jobId: IngestionJobId): Promise<IngestionJob | null>;
  /**
   * Merge a patch into an existing job and set `updatedAt`. Returns the
   * merged record. Fails if the job does not exist.
   */
  updateJob(
    jobId: IngestionJobId,
    patch: Partial<Omit<IngestionJob, 'jobId' | 'createdAt'>>,
    updatedAt: string,
  ): Promise<IngestionJob>;
  /**
   * Atomically mark the job FAILED unless it is already terminal (SUCCEEDED
   * or FAILED). A single conditional write, so a concurrent FINALIZE commit
   * can never be downgraded and an earlier, more specific error is kept.
   * Returns `NOT_APPLIED` when the job was terminal (or missing).
   */
  markFailedIfActive(
    jobId: IngestionJobId,
    error: IngestionJobError,
    updatedAt: string,
  ): Promise<'FAILED' | 'NOT_APPLIED'>;
}
