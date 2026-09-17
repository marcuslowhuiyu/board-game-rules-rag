import { describe, expect, it } from 'vitest';
import {
  asChunkId,
  asContentId,
  asEditionId,
  asGameId,
  asSourceDocumentId,
  type Chunk,
} from '@bgr/domain';
import { InMemoryChunksRepository } from './in-memory-chunks-repository.js';

const iso = '2026-09-17T00:00:00.000Z';

const makeChunk = (over: Partial<Chunk> = {}): Chunk => ({
  chunkId: asChunkId('ch_1'),
  documentId: asSourceDocumentId('doc_1'),
  gameId: asGameId('g_ti4'),
  editionId: asEditionId('e_1'),
  contentId: asContentId('c_base'),
  ordinal: 0,
  headingPath: ['Setup'],
  pageStart: 1,
  pageEnd: 1,
  textUri: 's3://b/normalized/doc_1/ch_1.txt',
  textPreview: 'text',
  charCount: 4,
  tokenCount: 1,
  authority: 'OFFICIAL_RULES',
  sourceType: 'RULEBOOK',
  isCurrent: true,
  createdAt: iso,
  ...over,
});

describe('InMemoryChunksRepository', () => {
  it('roundtrips a chunk', async () => {
    const repo = new InMemoryChunksRepository();
    await repo.putChunks([makeChunk()]);
    const items = await repo.listChunksForDocument(asSourceDocumentId('doc_1'));
    expect(items).toHaveLength(1);
    expect(items[0]!.chunkId).toBe('ch_1');
  });

  it('lists chunks in ordinal order', async () => {
    const repo = new InMemoryChunksRepository();
    await repo.putChunks([
      makeChunk({ chunkId: asChunkId('ch_c'), ordinal: 2 }),
      makeChunk({ chunkId: asChunkId('ch_a'), ordinal: 0 }),
      makeChunk({ chunkId: asChunkId('ch_b'), ordinal: 1 }),
    ]);
    const items = await repo.listChunksForDocument(asSourceDocumentId('doc_1'));
    expect(items.map((c) => c.chunkId)).toEqual(['ch_a', 'ch_b', 'ch_c']);
  });

  it('deleteChunksForDocument removes only that document', async () => {
    const repo = new InMemoryChunksRepository();
    await repo.putChunks([makeChunk()]);
    await repo.putChunks([
      makeChunk({ chunkId: asChunkId('ch_x'), documentId: asSourceDocumentId('doc_2') }),
    ]);
    await repo.deleteChunksForDocument(asSourceDocumentId('doc_1'));
    expect(await repo.listChunksForDocument(asSourceDocumentId('doc_1'))).toEqual([]);
    expect(await repo.listChunksForDocument(asSourceDocumentId('doc_2'))).toHaveLength(1);
  });
});
