import { describe, expect, it } from 'vitest';
import { InMemoryVectorIndex } from './in-memory-vector-index.js';
import type { ChunkVectorMetadata } from './vector-index.js';

const meta = (over: Partial<ChunkVectorMetadata> = {}): ChunkVectorMetadata => ({
  gameId: 'g_1',
  editionId: 'e_1',
  contentId: 'c_base',
  documentId: 'doc_1',
  authority: 'OFFICIAL_RULES',
  sourceType: 'RULEBOOK',
  headingPath: ['Setup'],
  pageStart: 1,
  pageEnd: 1,
  text: 'Each player takes 45 trains.',
  ...over,
});

const filter = { gameId: 'g_1', editionId: 'e_1', documentIds: ['doc_1'] };

describe('InMemoryVectorIndex', () => {
  it('returns the nearest vectors by cosine similarity, best first, up to topK', async () => {
    const index = new InMemoryVectorIndex();
    await index.putVectors([
      { key: 'far', vector: [0, 1], metadata: meta() },
      { key: 'near', vector: [1, 0.1], metadata: meta() },
      { key: 'mid', vector: [1, 1], metadata: meta() },
    ]);

    const hits = await index.query({ vector: [1, 0], topK: 2, filter });

    expect(hits.map((h) => h.key)).toEqual(['near', 'mid']);
    expect(hits[0]!.score).toBeCloseTo(0.995, 3);
    expect(hits[0]!.metadata.text).toBe('Each player takes 45 trains.');
  });

  it('applies every filter field before ranking', async () => {
    const index = new InMemoryVectorIndex();
    await index.putVectors([
      { key: 'ok', vector: [0, 1], metadata: meta() },
      { key: 'other-game', vector: [1, 0], metadata: meta({ gameId: 'g_2' }) },
      { key: 'other-edition', vector: [1, 0], metadata: meta({ editionId: 'e_2' }) },
      { key: 'other-doc', vector: [1, 0], metadata: meta({ documentId: 'doc_2' }) },
    ]);

    const hits = await index.query({ vector: [1, 0], topK: 10, filter });

    expect(hits.map((h) => h.key)).toEqual(['ok']);
  });

  it('overwrites a vector put again under the same key', async () => {
    const index = new InMemoryVectorIndex();
    await index.putVectors([{ key: 'k', vector: [1, 0], metadata: meta({ text: 'old' }) }]);
    await index.putVectors([{ key: 'k', vector: [1, 0], metadata: meta({ text: 'new' }) }]);

    const hits = await index.query({ vector: [1, 0], topK: 10, filter });
    expect(hits.map((h) => h.metadata.text)).toEqual(['new']);
  });
});
