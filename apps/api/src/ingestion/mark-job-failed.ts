import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoIngestionJobsRepository, type IngestionJobsRepository } from '@bgr/persistence';
import { IngestionStageSchema, asIngestionJobId, type IngestionStage } from '@bgr/domain';
import { createLogger } from '@bgr/shared';

/**
 * Lambda invoked from the Step Functions Catch path. Its job is to make
 * absolutely sure the DDB record shows the job as FAILED even when the
 * failure was itself in the stage-runner Lambda (Lambda service exception,
 * SDK client failure, timeout, etc.) — the stage runner may never have
 * reached its own `failJob` writeback in those cases.
 *
 * Input shape from Step Functions:
 *   {
 *     jobId:  <string>,
 *     stage:  <IngestionStage>,     // stage that was being invoked
 *     cause:  <string>,             // exception message, from States.ErrorInfo
 *     errorName?: <string>,         // exception class name
 *   }
 * Passing `stage` explicitly in the Task's payload keeps this handler
 * decoupled from the caught-error shape (which Step Functions marshals as
 * a JSON string).
 */
export interface MarkJobFailedEvent {
  jobId: string;
  stage: string;
  cause?: unknown;
  errorName?: string;
}

const logger = createLogger({ base: { app: 'bgr-ingestion', handler: 'mark-job-failed' } });

let cachedRepo: IngestionJobsRepository | undefined;

function repo(): IngestionJobsRepository {
  if (cachedRepo) return cachedRepo;
  const ddb = new DynamoDBClient({});
  cachedRepo = new DynamoIngestionJobsRepository(ddb, {
    ingestionJobsTable: requireEnv('INGESTION_JOBS_TABLE'),
  });
  return cachedRepo;
}

export function overrideRepoForTests(r: IngestionJobsRepository): void {
  cachedRepo = r;
}

export function resetRepoForTests(): void {
  cachedRepo = undefined;
}

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v || v.length === 0) throw new Error(`missing required env var: ${key}`);
  return v;
}

export interface MarkJobFailedOutput {
  jobId: string;
  /**
   * `SUCCEEDED` only when the job had already completed — the handler never
   * downgrades a finished job (e.g. the stage runner wrote SUCCEEDED but its
   * invocation then timed out and Step Functions took the Catch path).
   */
  status: 'FAILED' | 'SUCCEEDED';
  stage: IngestionStage;
}

export const handler = async (event: MarkJobFailedEvent): Promise<MarkJobFailedOutput> => {
  const jobId = asIngestionJobId(event.jobId);
  const stageResult = IngestionStageSchema.safeParse(event.stage);
  const stage: IngestionStage = stageResult.success ? stageResult.data : 'FINALIZE';
  const message = formatCause(event.cause);
  const code =
    typeof event.errorName === 'string' ? event.errorName.slice(0, 80) : 'STEPFUNCTIONS_FAILURE';

  // One conditional write: a job that is already terminal is left alone, so
  // a FINALIZE commit racing this handler is never downgraded and the stage
  // runner's more specific error is kept.
  const outcome = await repo().markFailedIfActive(
    jobId,
    { stage, message: message.slice(0, 2000), code },
    new Date().toISOString(),
  );
  if (outcome === 'FAILED') {
    logger.info('mark-job-failed: FAILED persisted', { jobId, stage, code });
    return { jobId, status: 'FAILED', stage };
  }
  const current = await repo().getJob(jobId);
  if (current?.status === 'SUCCEEDED') {
    logger.warn('mark-job-failed: job already SUCCEEDED, not overwriting', { jobId, stage, code });
    return { jobId, status: 'SUCCEEDED', stage: current.stage };
  }
  logger.info('mark-job-failed: job already FAILED or missing', { jobId, stage });
  return { jobId, status: 'FAILED', stage: current?.stage ?? stage };
};

function formatCause(cause: unknown): string {
  if (cause === undefined || cause === null) return 'Step Functions execution failed';
  if (typeof cause === 'string') return cause;
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}
