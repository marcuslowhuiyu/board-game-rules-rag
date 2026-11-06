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

/** A valid reply for each role's real schema. */
const REPLIES: Record<string, unknown> = {
  router: { tier: 'simple' },
  reranker: { order: ['P1'] },
  answerer: {
    appliedTier: 'OFFICIAL',
    certainty: 'DEFINITIVE',
    answer: 'Yes.',
    explanation: 'P1 says so.',
    evidence: ['P1'],
    tiers: [],
  },
};

class FakeModel implements StructuredModel {
  readonly seen: Array<{ key: string; role: string; schemaName: string }> = [];
  readonly schemas: Record<string, Record<string, unknown>> = {};
  async call<T>(req: StructuredRequest<T>) {
    this.seen.push({ key: req.entry.key, role: req.role, schemaName: req.schemaName });
    this.schemas[req.role] = req.jsonSchema;
    if (req.entry.key === 'bad') {
      const error = 'AccessDeniedException: no access';
      throw new ModelCallError(`Bedrock call failed: ${error}`, record(req, false, error), null);
    }
    return { value: req.schema.parse(REPLIES[req.role]), record: record(req, true) };
  }
}

describe('checkModels', () => {
  it('makes one call per approved entry and reports failures with their error text', async () => {
    const model = new FakeModel();
    const rows = await checkModels(catalog, model);
    expect(rows.map((r) => [r.key, r.role, r.ok])).toEqual([
      ['good', 'router', true],
      ['bad', 'router', false],
      ['rerankOnly', 'reranker', true],
      ['rerankOnly', 'answerer', true],
      ['idle', null, false],
    ]);
    expect(rows[0]).toMatchObject({ modelId: 'id-good', latencyMs: 120, costUsd: 0.001 });
    expect(rows[1]!.error).toMatch(/AccessDenied/);
    expect(rows[1]).toMatchObject({ latencyMs: 30, costUsd: 0.0002 });
    expect(rows[4]!.error).toMatch(/not approved for any role/);
  });

  it('calls each entry once per approved role, through that role, and never an unapproved one', async () => {
    const model = new FakeModel();
    await checkModels(catalog, model);
    expect(model.seen.map(({ key, role }) => ({ key, role }))).toEqual([
      { key: 'good', role: 'router' },
      { key: 'bad', role: 'router' },
      { key: 'rerankOnly', role: 'reranker' },
      { key: 'rerankOnly', role: 'answerer' },
    ]);
  });

  it("sends each role's real schema, so a schema the model rejects fails the check", async () => {
    const model = new FakeModel();
    await checkModels(catalog, model);
    // The answer schema, not a one-field stand-in: it has the nullable appliedTier and tier panels.
    expect(model.schemas['answerer']).toMatchObject({
      properties: { appliedTier: expect.anything(), tiers: expect.anything() },
    });
    expect(model.schemas['reranker']).toMatchObject({ properties: { order: expect.anything() } });
    expect(model.schemas['router']).toMatchObject({ properties: { tier: expect.anything() } });
  });
});

describe('exitCodeFor', () => {
  const row = (ok: boolean) => ({
    key: 'k',
    modelId: 'm',
    role: 'router' as const,
    ok,
    latencyMs: 1,
    costUsd: 0,
  });
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
