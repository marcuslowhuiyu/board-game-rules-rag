import { describe, expect, it } from 'vitest';
import { costUsd, loadModelCatalog, modelFor } from './catalog.js';

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
    expect(loadModelCatalog().defaults).toEqual({ router: 'nova-micro', reranker: 'nova-micro' });
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

  it('modelFor rejects an unapproved key', () => {
    expect(() => modelFor(loadModelCatalog(), 'router', 'gpt-6-luna')).toThrow(
      /not approved for router/,
    );
  });

  it('modelFor returns the default when no key is given', () => {
    expect(modelFor(loadModelCatalog(), 'reranker').key).toBe('nova-micro');
  });

  it('costUsd prices Nova Micro usage', () => {
    const nova = modelFor(loadModelCatalog(), 'router');
    expect(costUsd(nova, { inputTokens: 10_000, outputTokens: 200 })).toBeCloseTo(0.000378, 9);
  });
});
