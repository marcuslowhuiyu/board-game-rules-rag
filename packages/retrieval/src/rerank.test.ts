import type { PassageRanker } from '@bgr/ai';
import type { Logger } from '@bgr/shared';
import { describe, expect, it, vi } from 'vitest';
import { rerankEvidence } from './rerank.js';
import type { RetrievedChunk } from './vector-rules-retriever.js';

const chunk = (chunkId: string, score: number) =>
  ({ chunkId, score, text: `text ${chunkId}`, headingPath: ['H', chunkId] }) as RetrievedChunk;

const candidates = [chunk('b', 0.5), chunk('a', 0.9), chunk('c', 0.1)];

const rankerReturning = (orderedIds: string[]) => {
  const rank = vi.fn().mockResolvedValue({ orderedIds, record: {} });
  return { ranker: { rank } as unknown as PassageRanker, rank };
};

const fakeLogger = () => {
  const warn = vi.fn();
  return { logger: { warn } as unknown as Logger, warn };
};

const ids = (chunks: RetrievedChunk[]) => chunks.map((c) => c.chunkId);

describe('rerankEvidence', () => {
  it("reorders candidates by the ranker's order", async () => {
    const { ranker, rank } = rankerReturning(['c', 'a', 'b']);
    const out = await rerankEvidence('q', candidates, ranker, { correlationId: 'cid' });
    expect(ids(out.ranked)).toEqual(['c', 'a', 'b']);
    expect(out.fallback).toBe(false);
    expect(rank).toHaveBeenCalledWith(
      'q',
      [
        { id: 'b', text: 'text b', headingPath: ['H', 'b'] },
        { id: 'a', text: 'text a', headingPath: ['H', 'a'] },
        { id: 'c', text: 'text c', headingPath: ['H', 'c'] },
      ],
      'cid',
    );
  });

  it('keeps every candidate exactly once', async () => {
    const { ranker } = rankerReturning(['c', 'x-unknown', 'c', 'a']);
    const out = await rerankEvidence('q', candidates, ranker);
    expect(ids(out.ranked)).toEqual(['c', 'a', 'b']);
    expect(out.ranked).toHaveLength(candidates.length);
    expect(new Set(ids(out.ranked)).size).toBe(candidates.length);
  });

  it('appends omitted candidates in score order', async () => {
    const { ranker } = rankerReturning(['c']);
    const out = await rerankEvidence('q', candidates, ranker);
    expect(ids(out.ranked)).toEqual(['c', 'a', 'b']);
    expect(out.fallback).toBe(false);
  });

  it('falls back to score order when the ranker throws', async () => {
    const ranker = {
      rank: vi.fn().mockRejectedValue(new Error('boom')),
    } as unknown as PassageRanker;
    const { logger, warn } = fakeLogger();
    const out = await rerankEvidence('q', candidates, ranker, { logger, correlationId: 'cid' });
    expect(ids(out.ranked)).toEqual(['a', 'b', 'c']);
    expect(out.fallback).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls[0])).toContain('cid');
  });

  it('skips the ranker for empty candidates', async () => {
    const { ranker, rank } = rankerReturning([]);
    const out = await rerankEvidence('q', [], ranker);
    expect(out).toEqual({ ranked: [], fallback: false });
    expect(rank).not.toHaveBeenCalled();
  });
});
