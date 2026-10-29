import type { ModelCallRecord, ModelEntry } from '@bgr/ai';
import { describe, expect, it } from 'vitest';
import { CostMeter, estimateCostUsd } from './cost-meter.js';

const record = (costUsd: number): ModelCallRecord => ({
  role: 'reranker',
  modelKey: 'k',
  modelId: 'm',
  promptVersion: 'v',
  inputTokens: 10,
  outputTokens: 5,
  latencyMs: 1,
  costUsd,
  attempts: 1,
  ok: true,
});

describe('CostMeter', () => {
  it('is exhausted once spend reaches the maximum', () => {
    const meter = new CostMeter(0.75);
    meter.record(record(0.4));
    expect(meter.exhausted).toBe(false);
    meter.record(record(0.4));
    expect(meter.spentUsd).toBeCloseTo(0.8);
    expect(meter.exhausted).toBe(true);
  });

  it('counts calls and tokens, failed calls included', () => {
    const meter = new CostMeter(1);
    meter.record(record(0.1));
    meter.record({ ...record(0.1), ok: false, error: 'bad' });
    expect(meter.calls).toBe(2);
    expect(meter.inputTokens).toBe(20);
    expect(meter.outputTokens).toBe(10);
  });

  it('a zero maximum is exhausted from the start', () => {
    expect(new CostMeter(0).exhausted).toBe(true);
  });
});

describe('estimateCostUsd', () => {
  const entry = { inputUsdPerMTok: 0.5, outputUsdPerMTok: 2 } as ModelEntry;
  it('sums calls x per-call token cost across plans', () => {
    // 10 calls x (1000 in, 100 out): 10 * (1000*0.5 + 100*2) / 1e6 = 0.007
    // 5 calls x (200 in, 20 out): 5 * (200*0.5 + 20*2) / 1e6 = 0.0007
    const usd = estimateCostUsd([
      { entry, calls: 10, inputTokensPerCall: 1000, outputTokensPerCall: 100 },
      { entry, calls: 5, inputTokensPerCall: 200, outputTokensPerCall: 20 },
    ]);
    expect(usd).toBeCloseTo(0.0077, 8);
  });
  it('is zero with no plans', () => {
    expect(estimateCostUsd([])).toBe(0);
  });
});
