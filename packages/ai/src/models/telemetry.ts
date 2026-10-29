import type { ModelRole } from './catalog.js';

/** One structured model call, summed over its retries. Emitted exactly once per call. */
export interface ModelCallRecord {
  role: ModelRole;
  modelKey: string;
  modelId: string;
  promptVersion: string;
  correlationId?: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  costUsd: number;
  attempts: number;
  ok: boolean;
  error?: string;
}

export type ModelCallSink = (record: ModelCallRecord) => void;
