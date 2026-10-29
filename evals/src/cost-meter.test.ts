import type { ModelCallRecord } from '@bgr/ai';
import { describe, expect, it } from 'vitest';
import { CostMeter } from './cost-meter.js';

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
