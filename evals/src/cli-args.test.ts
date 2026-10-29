import { describe, expect, it } from 'vitest';
import { checkModelFlags } from './cli-args.js';

describe('checkModelFlags', () => {
  it('requires --max-cost with --rerank', () => {
    expect(() => checkModelFlags({ rerank: true })).toThrow(/--max-cost/);
  });
  it('requires --max-cost with --route', () => {
    expect(() => checkModelFlags({ route: true })).toThrow(/--max-cost/);
  });
  it('rejects a bad --max-cost', () => {
    expect(() => checkModelFlags({ rerank: true, maxCost: 'abc' })).toThrow(/--max-cost/);
    expect(() => checkModelFlags({ rerank: true, maxCost: '-1' })).toThrow(/--max-cost/);
  });
  it('returns the cap, or undefined when no model is used', () => {
    expect(checkModelFlags({ rerank: true, maxCost: '0.5' })).toBe(0.5);
    expect(checkModelFlags({})).toBeUndefined();
  });
});
