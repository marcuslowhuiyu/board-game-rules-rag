import { describe, expect, it } from 'vitest';
import { selectEvidence } from './select-evidence.js';
import type { RetrievedChunk } from './vector-rules-retriever.js';

const chunk = (chunkId: string, score: number) => ({ chunkId, score }) as RetrievedChunk;

describe('selectEvidence', () => {
  it('keeps the highest-scoring candidates, best first, up to the limit', () => {
    const picked = selectEvidence([chunk('b', 0.5), chunk('a', 0.9), chunk('c', 0.1)], 2);
    expect(picked.map((c) => c.chunkId)).toEqual(['a', 'b']);
  });

  it('returns every candidate when there are fewer than the limit', () => {
    expect(selectEvidence([chunk('a', 0.9)], 6).map((c) => c.chunkId)).toEqual(['a']);
  });
});
