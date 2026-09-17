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
  nextStage: string | null;
  status: string;
  duplicate?: boolean;
  chunkCount?: number;
  documentId?: string;
  supersededDocumentId?: string;
}

/**
 * Lambda handler for one ingestion stage. The Step Function invokes it once
 * per stage in the pipeline. Throwing from here surfaces to Step Functions
 * as a Task failure, which the state machine catches and routes to the
 * FailStage state.
 */
export const handler = async (event: StageRunnerEvent): Promise<StageRunnerOutput> => {
  const parsed = EventSchema.parse(event);
  const ctx = getStageContext();
  const result: RunStageResult = await runStage(parsed.jobId, parsed.stage, ctx);
  const out: StageRunnerOutput = {
    jobId: result.job.jobId,
    stage: result.ranStage,
    nextStage: result.nextStage,
    status: result.job.status,
  };
  if (result.duplicate) out.duplicate = true;
  if (result.chunkCount !== undefined) out.chunkCount = result.chunkCount;
  if (result.documentId !== undefined) out.documentId = result.documentId;
  if (result.supersededDocumentId !== undefined) {
    out.supersededDocumentId = result.supersededDocumentId;
  }
  return out;
};
