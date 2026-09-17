import {
  ConflictError,
  IngestionJobSchema,
  NotFoundError,
  type IngestionJob,
  type IngestionJobId,
} from '@bgr/domain';
import type { IngestionJobsRepository } from './ingestion-jobs-repository.js';

export class InMemoryIngestionJobsRepository implements IngestionJobsRepository {
  private readonly byId = new Map<IngestionJobId, IngestionJob>();

  async createJob(job: IngestionJob): Promise<void> {
    if (this.byId.has(job.jobId)) {
      throw new ConflictError(`ingestion job already exists: ${job.jobId}`);
    }
    this.byId.set(job.jobId, { ...job });
  }

  async getJob(jobId: IngestionJobId): Promise<IngestionJob | null> {
    return this.byId.get(jobId) ?? null;
  }

  async updateJob(
    jobId: IngestionJobId,
    patch: Partial<Omit<IngestionJob, 'jobId' | 'createdAt'>>,
    updatedAt: string,
  ): Promise<IngestionJob> {
    const current = this.byId.get(jobId);
    if (!current) throw new NotFoundError('ingestionJob', jobId);
    const merged = IngestionJobSchema.parse({ ...current, ...patch, updatedAt });
    this.byId.set(jobId, merged);
    return merged;
  }
}
