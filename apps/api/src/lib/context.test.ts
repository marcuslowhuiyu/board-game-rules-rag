import { describe, expect, it } from 'vitest';
import { loadAnsweringConfigFromEnv } from './context.js';

const ENV = {
  USAGE_TABLE: 'usage',
  DAILY_AI_CAP_USD: '1.00',
  MODEL_REQUEST_TIMEOUT_MS: '20000',
  EVIDENCE_LIMIT_SIMPLE: '3',
  EVIDENCE_LIMIT_COMPLEX: '10',
  RERANK_CANDIDATES: '15',
  RERANK_TOP_N: '10',
};

describe('loadAnsweringConfigFromEnv', () => {
  it('parses every setting', () => {
    expect(loadAnsweringConfigFromEnv(ENV)).toEqual({
      usageTable: 'usage',
      dailyAiCapUsd: 1,
      modelRequestTimeoutMs: 20000,
      evidenceLimits: { simple: 3, complex: 10 },
      rerankCandidates: 15,
      rerankTopN: 10,
    });
  });

  it.each(Object.keys(ENV))('names %s when it is missing', (key) => {
    expect(() => loadAnsweringConfigFromEnv({ ...ENV, [key]: undefined })).toThrow(key);
  });

  it.each([
    ['DAILY_AI_CAP_USD', 'abc'],
    ['DAILY_AI_CAP_USD', '0'],
    ['DAILY_AI_CAP_USD', '-1'],
    ['DAILY_AI_CAP_USD', 'Infinity'],
    ['MODEL_REQUEST_TIMEOUT_MS', 'NaN'],
    ['MODEL_REQUEST_TIMEOUT_MS', '0'],
    ['EVIDENCE_LIMIT_SIMPLE', '2.5'],
    ['EVIDENCE_LIMIT_COMPLEX', '-3'],
    ['RERANK_CANDIDATES', ' '],
    ['RERANK_TOP_N', '0'],
  ])('rejects %s=%j with a clear error', (key, value) => {
    expect(() => loadAnsweringConfigFromEnv({ ...ENV, [key]: value })).toThrow(key);
  });
});
