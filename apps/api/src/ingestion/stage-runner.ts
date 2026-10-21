import { IngestionStageSchema } from '@bgr/domain';
import { z } from 'zod';
import { getStageContext } from './stage-context.js';
import { runStage, type RunStageResult } from './pipeline.js';

const EventSchema = z.object({
  jobId: z.string().min(1),
  stage: IngestionStageSchema,
});

export interface StageRunnerEvent {
  jobId: string;
  stage: string;
}

export interface StageRunnerOutput {
  jobId: string;
  stage: string;
  status: string;
  nextStage: string | null;
  /**
   * The Step Functions Choice state branches on this together with `status`:
   * `terminal && status === 'SUCCEEDED'` short-circuits to Succeed (e.g.
   * FETCH duplicate); any other terminal result routes through
   * MarkJobFailed to the Fail state.
   */
  terminal: boolean;
  duplicate?: boolean;
  alreadyTerminal?: boolean;
  chunkCount?: number;
  documentId?: string;
  supersededDocumentId?: string;
}

/**
 * Lambda handler for one ingestion stage. The Step Function invokes it
 * once per stage. Two ways a stage can terminate the pipeline:
 *   1. Thrown error → caught by state machine, MarkJobFailed writes FAILED
 *      (except `RetryableStageError` from FINALIZE, which is retried first).
 *   2. Result with `terminal: true` → Choice state jumps to PipelineSucceeded
 *      when the job is SUCCEEDED (FETCH duplicate, FINALIZE, or redelivery
 *      against a finished job), otherwise via MarkJobFailed to PipelineFailed.
 */
export const handler = async (event: StageRunnerEvent): Promise<StageRunnerOutput> => {
  const parsed = EventSchema.parse(event);
  const ctx = getStageContext();
  const result: RunStageResult = await runStage(parsed.jobId, parsed.stage, ctx);
  const out: StageRunnerOutput = {
    jobId: result.job.jobId,
    stage: result.ranStage,
    status: result.status,
    nextStage: result.nextStage,
    terminal: result.terminal,
  };
  if (result.duplicate) out.duplicate = true;
  if (result.alreadyTerminal) out.alreadyTerminal = true;
  if (result.chunkCount !== undefined) out.chunkCount = result.chunkCount;
  if (result.documentId !== undefined) out.documentId = result.documentId;
  if (result.supersededDocumentId !== undefined) {
    out.supersededDocumentId = result.supersededDocumentId;
  }
  return out;
};
