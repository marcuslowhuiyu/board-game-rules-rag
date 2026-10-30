import {
  ModelCallError,
  type ModelCallRecord,
  type ModelCatalog,
  type ModelEntry,
  type StructuredModel,
  type StructuredRequest,
} from '@bgr/ai';
import { describe, expect, it } from 'vitest';
import { checkModels, exitCodeFor, formatRows } from './check-models.js';

const entry = (key: string, structuredOutput: 'native' | 'json' = 'native'): ModelEntry => ({
  key,
  displayName: key,
  modelId: `id-${key}`,
  region: 'ap-southeast-1',
  inputUsdPerMTok: 1,
  outputUsdPerMTok: 1,
  structuredOutput,
  maxTokens: 50,
  temperature: 0,
});

const catalog: ModelCatalog = {
  models: {
    good: entry('good'),
    bad: entry('bad', 'json'),
    rerankOnly: entry('rerankOnly'),
    idle: entry('idle'),
  },
  approved: { router: ['good', 'bad'], reranker: ['rerankOnly'], answerer: ['rerankOnly'] },
  defaults: { router: 'good', reranker: 'rerankOnly', answerer: 'rerankOnly' },
};

const record = (req: StructuredRequest<unknown>, ok: boolean, error?: string): ModelCallRecord => ({
  role: req.role,
  modelKey: req.entry.key,
  modelId: req.entry.modelId,
  promptVersion: req.promptVersion,
  inputTokens: 10,
  cacheReadInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 2,
  latencyMs: ok ? 120 : 30,
  costUsd: ok ? 0.001 : 0.0002,
  attempts: 1,
  ok,
  ...(error === undefined ? {} : { error }),
});

class FakeModel implements StructuredModel {
  readonly seen: Array<{ key: string; role: string }> = [];
  async call<T>(req: StructuredRequest<T>) {
    this.seen.push({ key: req.entry.key, role: req.role });
    if (req.entry.key === 'bad') {
      const error = 'AccessDeniedException: no access';
      throw new ModelCallError(`Bedrock call failed: ${error}`, record(req, false, error), null);
    }
    return { value: req.schema.parse({ tier: 'simple' }), record: record(req, true) };
  }
}

describe('checkModels', () => {
  it('makes one call per approved entry and reports failures with their error text', async () => {
    const model = new FakeModel();
    const rows = await checkModels(catalog, model);
    expect(rows.map((r) => [r.key, r.ok])).toEqual([
      ['good', true],
      ['bad', false],
      ['rerankOnly', true],
      ['idle', false],
    ]);
    expect(rows[0]).toMatchObject({ modelId: 'id-good', latencyMs: 120, costUsd: 0.001 });
    expect(rows[1]!.error).toMatch(/AccessDenied/);
    expect(rows[1]).toMatchObject({ latencyMs: 30, costUsd: 0.0002 });
    expect(rows[3]!.error).toMatch(/not approved for any role/);
  });

  it('calls each entry with the first role it is approved for, and never an unapproved one', async () => {
    const model = new FakeModel();
    await checkModels(catalog, model);
    expect(model.seen).toEqual([
      { key: 'good', role: 'router' },
      { key: 'bad', role: 'router' },
      { key: 'rerankOnly', role: 'reranker' },
    ]);
  });
});

describe('exitCodeFor', () => {
  const row = (ok: boolean) => ({ key: 'k', modelId: 'm', ok, latencyMs: 1, costUsd: 0 });
  it('is 0 when every row passed and 1 when any failed', () => {
    expect(exitCodeFor([row(true), row(true)])).toBe(0);
    expect(exitCodeFor([row(true), row(false)])).toBe(1);
  });
});

describe('formatRows', () => {
  it('prints a line per row and the total cost', async () => {
    const rows = await checkModels(catalog, new FakeModel());
    const text = formatRows(rows);
    expect(text).toContain('rerankOnly');
    expect(text).toContain('FAIL');
    expect(text).toMatch(/total cost: \$0\.0\d+/);
  });
});
