import { describe, expect, it } from 'vitest';
import { createEvalModels } from './models.js';

describe('createEvalModels', () => {
  it('wires the catalog default reranker and router without calling anything', () => {
    const m = createEvalModels({ maxUsd: 1, rerank: true, route: true });
    expect(m.ranker).toBeDefined();
    expect(m.classifier).toBeDefined();
    expect(m.models['reranker']!.key).toBeTruthy();
    expect(m.promptVersions['router']).toMatch(/router/);
    expect(m.meter.calls).toBe(0);
  });

  it('rejects an unapproved reranker key', () => {
    expect(() =>
      createEvalModels({ maxUsd: 1, rerank: true, rerankKey: 'nope', route: false }),
    ).toThrow(/not approved/);
  });

  it('builds nothing that is not asked for', () => {
    const m = createEvalModels({ maxUsd: 1, rerank: false, route: false });
    expect(m.ranker).toBeUndefined();
    expect(m.classifier).toBeUndefined();
  });
});
