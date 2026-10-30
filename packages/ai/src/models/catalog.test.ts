import { describe, expect, it } from 'vitest';
import { costUsd, loadModelCatalog, modelFor, type ModelEntry } from './catalog.js';

const entry = {
  key: 'm',
  displayName: 'M',
  modelId: 'id',
  region: 'ap-southeast-1',
  inputUsdPerMTok: 1,
  outputUsdPerMTok: 2,
  structuredOutput: 'json',
  maxTokens: 10,
  temperature: 0,
};

const bad = (approved: unknown, defaults: unknown) => ({
  models: { m: entry },
  approved,
  defaults,
});

describe('model catalog', () => {
  it('bundled config parses and defaults are approved', () => {
    expect(loadModelCatalog().defaults).toEqual({ router: 'nova-micro', reranker: 'gpt-6-luna' });
  });

  it('accepts a model entry without temperature', () => {
    const { temperature: _omit, ...noTemp } = entry;
    const catalog = loadModelCatalog({
      models: { m: noTemp },
      approved: { router: ['m'], reranker: ['m'] },
      defaults: { router: 'm', reranker: 'm' },
    });
    expect(catalog.models['m']).not.toHaveProperty('temperature');
  });

  it('rejects a default that is not approved for its role', () => {
    expect(() =>
      loadModelCatalog(bad({ router: ['m'], reranker: ['m'] }, { router: 'm', reranker: 'other' })),
    ).toThrow();
  });

  it('rejects an approved key with no model entry', () => {
    expect(() =>
      loadModelCatalog(
        bad({ router: ['m', 'ghost'], reranker: ['m'] }, { router: 'm', reranker: 'm' }),
      ),
    ).toThrow();
  });

  it('GPT-6 Luna sends reasoning effort in the nested reasoning field', () => {
    // Bedrock rejects top-level `reasoning_effort` and temperature for GPT-6 Luna.
    expect(loadModelCatalog().models['gpt-6-luna']?.additionalModelRequestFields).toEqual({
      text: { format: { strict: true } },
      reasoning: { effort: 'low' },
    });
  });

  it('modelFor rejects an unapproved key', () => {
    expect(() => modelFor(loadModelCatalog(), 'router', 'gpt-6-luna')).toThrow(
      /not approved for router/,
    );
  });

  it('modelFor returns the default when no key is given', () => {
    expect(modelFor(loadModelCatalog(), 'reranker').key).toBe('gpt-6-luna');
  });

  it('costUsd prices Nova Micro usage', () => {
    const nova = modelFor(loadModelCatalog(), 'router');
    expect(costUsd(nova, { inputTokens: 10_000, outputTokens: 200 })).toBeCloseTo(0.000378, 9);
  });

  describe('costUsd with prompt-cache tokens', () => {
    const luna = { ...entry, inputUsdPerMTok: 0.1, outputUsdPerMTok: 0.5 } as ModelEntry;
    const usage = {
      inputTokens: 2,
      outputTokens: 143,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 5537,
    };

    it('charges cache tokens at the input price when no cache prices are set', () => {
      expect(costUsd(luna, usage)).toBeCloseTo(((2 + 5537) * 0.1 + 143 * 0.5) / 1e6, 12);
    });

    it('uses explicit cache prices when set', () => {
      const priced = { ...luna, cacheReadUsdPerMTok: 0.01, cacheWriteUsdPerMTok: 0.125 };
      expect(costUsd(priced, { ...usage, cacheReadInputTokens: 1000 })).toBeCloseTo(
        (2 * 0.1 + 143 * 0.5 + 1000 * 0.01 + 5537 * 0.125) / 1e6,
        12,
      );
    });

    it('counts absent cache fields as 0', () => {
      expect(costUsd(luna, { inputTokens: 10, outputTokens: 4 })).toBeCloseTo(
        (10 * 0.1 + 4 * 0.5) / 1e6,
        12,
      );
    });

    it('accepts cache prices in the catalog and rejects negative ones', () => {
      const load = (extra: object) =>
        loadModelCatalog({
          models: { m: { ...entry, ...extra } },
          approved: { router: ['m'], reranker: ['m'] },
          defaults: { router: 'm', reranker: 'm' },
        });
      expect(
        load({ cacheReadUsdPerMTok: 0.01, cacheWriteUsdPerMTok: 0.2 }).models['m'],
      ).toMatchObject({
        cacheReadUsdPerMTok: 0.01,
        cacheWriteUsdPerMTok: 0.2,
      });
      expect(() => load({ cacheReadUsdPerMTok: -1 })).toThrow();
    });
  });
});
