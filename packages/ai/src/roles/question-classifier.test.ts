import { describe, expect, it } from 'vitest';
import type { StructuredModel, StructuredRequest } from '../bedrock/converse-structured.js';
import type { ModelEntry } from '../models/catalog.js';
import type { ModelCallRecord } from '../models/telemetry.js';
import { ROUTER_PROMPT_VERSION, createQuestionClassifier } from './question-classifier.js';

const entry: ModelEntry = {
  key: 'nova-micro',
  displayName: 'Nova Micro',
  modelId: 'apac.amazon.nova-micro-v1:0',
  region: 'ap-southeast-1',
  inputUsdPerMTok: 1,
  outputUsdPerMTok: 2,
  structuredOutput: 'native',
  maxTokens: 64,
  temperature: 0,
};

const record: ModelCallRecord = {
  role: 'router',
  modelKey: 'nova-micro',
  modelId: entry.modelId,
  promptVersion: ROUTER_PROMPT_VERSION,
  inputTokens: 1,
  outputTokens: 1,
  latencyMs: 1,
  costUsd: 0,
  attempts: 1,
  ok: true,
};

function fake(value: unknown) {
  const requests: StructuredRequest<unknown>[] = [];
  const model: StructuredModel = {
    call: async <T>(req: StructuredRequest<T>) => {
      requests.push(req as StructuredRequest<unknown>);
      return { value: req.schema.parse(value), record };
    },
  };
  return { model, requests };
}

describe('question classifier', () => {
  it('returns the tier and sends the router prompt version', async () => {
    const { model, requests } = fake({ tier: 'complex' });
    const result = await createQuestionClassifier(model, entry).classify('Q?', 'corr-1');
    expect(result.tier).toBe('complex');
    expect(result.record).toBe(record);
    expect(requests).toHaveLength(1);
    const req = requests[0]!;
    expect(req.role).toBe('router');
    expect(req.entry).toBe(entry);
    expect(req.promptVersion).toBe('router-v1');
    expect(req.correlationId).toBe('corr-1');
    expect(req.user).toContain('Q?');
    expect(req.jsonSchema['additionalProperties']).toBe(false);
  });

  it('rejects a tier outside the schema', async () => {
    const { model } = fake({ tier: 'medium' });
    await expect(createQuestionClassifier(model, entry).classify('Q?')).rejects.toThrow();
  });
});
