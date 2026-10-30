import { costUsd, type ModelCallRecord, type ModelEntry } from '@bgr/ai';

/**
 * Sums the cost of every model call, failed ones included (a failed call is
 * still billed). Feed it from `ConverseStructuredModel`'s `onCall` sink.
 */
export class CostMeter {
  private spent = 0;
  private callCount = 0;
  private inTokens = 0;
  private outTokens = 0;
  private cacheRead = 0;
  private cacheWrite = 0;

  constructor(private readonly maxUsd: number) {}

  record(r: ModelCallRecord): void {
    this.spent += r.costUsd;
    this.callCount += 1;
    this.inTokens += r.inputTokens;
    this.outTokens += r.outputTokens;
    this.cacheRead += r.cacheReadInputTokens;
    this.cacheWrite += r.cacheWriteInputTokens;
  }

  get spentUsd(): number {
    return this.spent;
  }
  get calls(): number {
    return this.callCount;
  }
  get cacheReadInputTokens(): number {
    return this.cacheRead;
  }
  get cacheWriteInputTokens(): number {
    return this.cacheWrite;
  }
  /** Uncached input tokens only; add the cache fields for the total. */
  get inputTokens(): number {
    return this.inTokens;
  }
  get outputTokens(): number {
    return this.outTokens;
  }
  get exhausted(): boolean {
    return this.spent >= this.maxUsd;
  }
}

/** Rough up-front cost of a planned run: calls x per-call tokens, priced from the model's catalog entry. */
export function estimateCostUsd(
  plannedCalls: readonly {
    entry: ModelEntry;
    calls: number;
    inputTokensPerCall: number;
    outputTokensPerCall: number;
  }[],
): number {
  return plannedCalls.reduce(
    (sum, p) =>
      sum +
      p.calls *
        costUsd(p.entry, {
          inputTokens: p.inputTokensPerCall,
          outputTokens: p.outputTokensPerCall,
          cacheReadInputTokens: 0,
          cacheWriteInputTokens: 0,
        }),
    0,
  );
}
