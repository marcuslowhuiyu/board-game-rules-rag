import type { ModelRole } from './catalog.js';

/** One structured model call, summed over its retries. Emitted exactly once per call. */
export interface ModelCallRecord {
  role: ModelRole;
  modelKey: string;
  modelId: string;
  promptVersion: string;
  correlationId?: string;
  /** Uncached input tokens. */
  inputTokens: number;
  /** Input tokens read from Bedrock's prompt cache (0 when the model reports none). */
  cacheReadInputTokens: number;
  /** Input tokens written to the prompt cache (0 when the model reports none). */
  cacheWriteInputTokens: number;
  outputTokens: number;
  latencyMs: number;
  costUsd: number;
  attempts: number;
  /** Converse stopReason of the last attempt (e.g. end_turn, max_tokens), when one was received. */
  stopReason?: string;
  ok: boolean;
  error?: string;
}

export type ModelCallSink = (record: ModelCallRecord) => void;
