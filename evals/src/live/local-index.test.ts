import type { Chunk } from '@bgr/domain';
import { chunkVectorMetadata, embeddingText } from '@bgr/retrieval';
import { describe, expect, it } from 'vitest';
import { HashEmbedder } from '../testing/hash-embedder.js';
import { buildLocalIndex, type CorpusChunk } from './local-index.js';

const corpusChunk = (id: string, text: string, headingPath: string[]): CorpusChunk => ({
  chunk: {
    chunkId: id,
    documentId: 'doc_1',
    gameId: 'g_1',
    editionId: 'e_1',
    contentId: 'c_base',
    ordinal: 0,
    headingPath,
    pageStart: 1,
    pageEnd: 1,
    textUri: `s3://b/normalized/doc_1/${id}.txt`,
    textPreview: text,
    charCount: text.length,
    tokenCount: 0,
    authority: 'OFFICIAL_RULES',
    sourceType: 'RULEBOOK',
    createdAt: '2026-10-27T00:00:00.000Z',
  } as Chunk,
  text,
  gameName: 'Starfall',
  contentName: 'Base game',
});

describe('buildLocalIndex', () => {
  it('embeds each chunk the way the EMBED stage does and keys it by chunk id', async () => {
    const corpus = [
      corpusChunk('chk_a', 'Draw two cards at the start of your turn.', ['Turn', 'Draw']),
      corpusChunk('chk_b', 'The game ends when the deck runs out.', []),
    ];
    const embedder = new HashEmbedder();

    const index = await buildLocalIndex(corpus, embedder);

    const entries = index.entries().sort((a, b) => a.key.localeCompare(b.key));
    expect(entries.map((e) => e.key)).toEqual(['chk_a', 'chk_b']);
    const expected = await embedder.embed(
      corpus.map((c) =>
        embeddingText({
          gameName: c.gameName,
          contentName: c.contentName,
          headingPath: c.chunk.headingPath,
          text: c.text,
        }),
      ),
    );
    expect(entries.map((e) => e.vector)).toEqual(expected.vectors);
    expect(entries[0]!.metadata).toEqual(chunkVectorMetadata(corpus[0]!.chunk, corpus[0]!.text));
  });
});
