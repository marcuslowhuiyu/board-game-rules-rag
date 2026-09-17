import type { IngestionJob, IngestionJobId } from '@bgr/domain';

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
}
