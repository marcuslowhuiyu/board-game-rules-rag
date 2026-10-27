import type { RetrievedChunk } from '@bgr/retrieval';
import { describe, expect, it } from 'vitest';
import type { RetrievalCase } from '../dataset/case-schema.js';
import { scoreCase } from './score-case.js';

const chunk = (text: string): RetrievedChunk =>
  ({ chunkId: text, text, headingPath: [], score: 0 }) as unknown as RetrievedChunk;

const simple: RetrievalCase = {
  id: 'simple',
  game: 'g',
  edition: 'base',
  enabledContent: ['base'],
  tier: 'simple',
  question: 'q',
  requiredEvidence: [{ key: 'a', phrase: 'alpha rule', required: true }],
  source: { url: 'https://example.com/t', title: 't' },
};

const complex: RetrievalCase = {
  ...simple,
  id: 'complex',
  tier: 'complex',
  requiredEvidence: [
    { key: 'a', phrase: 'alpha rule', required: true },
    { key: 'b', phrase: 'beta rule', required: true },
    { key: 'c', phrase: 'gamma rule', required: true },
  ],
};

const filler = (n: number) => Array.from({ length: n }, (_, i) => chunk(`noise ${i}`));

describe('scoreCase', () => {
  it('simple case hit at rank 2', () => {
    const r = scoreCase(simple, [chunk('noise'), chunk('the alpha rule says'), ...filler(3)]);
    expect(r.recallAt[1]).toBe(0);
    expect(r.recallAt[3]).toBe(1);
    expect(r.fullCoverageAt[3]).toBe(true);
    expect(r.reciprocalRank).toBe(0.5);
  });

  it('complex case with 2 of 3 required in top 10', () => {
    const r = scoreCase(complex, [chunk('alpha rule'), ...filler(4), chunk('beta rule')]);
    expect(r.recallAt[10]).toBeCloseTo(2 / 3);
    expect(r.fullCoverageAt[10]).toBe(false);
    expect(r.itemRanks).toEqual({ a: 1, b: 6, c: null });
  });

  it('supporting items reported but not counted', () => {
    const c: RetrievalCase = {
      ...simple,
      requiredEvidence: [
        { key: 'a', phrase: 'alpha rule', required: true },
        { key: 's', phrase: 'support line', required: false },
      ],
    };
    const r = scoreCase(c, [chunk('support line'), ...filler(5)]);
    expect(r.itemRanks['s']).toBe(1);
    expect(r.recallAt[10]).toBe(0);
    expect(r.reciprocalRank).toBe(0);
  });

  it('one chunk satisfies two items', () => {
    const r = scoreCase(complex, [chunk('noise'), chunk('alpha rule and beta rule')]);
    expect(r.itemRanks['a']).toBe(2);
    expect(r.itemRanks['b']).toBe(2);
  });

  it('item matched by several chunks takes best rank', () => {
    const r = scoreCase(simple, [chunk('x'), chunk('alpha rule'), chunk('alpha rule again')]);
    expect(r.itemRanks['a']).toBe(2);
  });

  it('counts top-5 chunks that match no item as irrelevant', () => {
    const r = scoreCase(simple, [chunk('alpha rule'), ...filler(4)]);
    expect(r.irrelevantTop5).toBeCloseTo(4 / 5);
  });

  it('empty retrieval scores zero', () => {
    const r = scoreCase(complex, []);
    expect(r.retrieved).toBe(0);
    expect(Object.values(r.recallAt)).toEqual([0, 0, 0, 0]);
    expect(r.reciprocalRank).toBe(0);
    expect(r.irrelevantTop5).toBe(0);
  });
});
