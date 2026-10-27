import type { Chunk } from '@bgr/domain';
import { describe, expect, it } from 'vitest';
import { chunkVectorMetadata, embeddingText } from './chunk-vectors.js';

const chunk = (over: Partial<Chunk> = {}): Chunk =>
  ({
    chunkId: 'chk_1',
    documentId: 'doc_1',
    gameId: 'g_1',
    editionId: 'e_1',
    contentId: 'c_base',
    ordinal: 0,
    headingPath: ['Setup', 'Trains'],
    pageStart: 2,
    pageEnd: 3,
    textUri: 's3://bucket/normalized/doc_1/chk_1.txt',
    textPreview: 'Each player takes 45 trains.',
    charCount: 28,
    tokenCount: 7,
    authority: 'OFFICIAL_RULES',
    sourceType: 'RULEBOOK',
    createdAt: '2026-10-27T00:00:00.000Z',
    ...over,
  }) as Chunk;

describe('embeddingText', () => {
  it('prefixes the chunk with its game, content and section', () => {
    expect(
      embeddingText({
        gameName: 'Ticket to Ride',
        contentName: 'Base game',
        headingPath: ['Setup', 'Trains'],
        text: 'Each player takes 45 trains.',
      }),
    ).toBe(
      'Game: Ticket to Ride\nContent: Base game\nSection: Setup > Trains\n\nEach player takes 45 trains.',
    );
  });

  it('leaves out the section line when the chunk has no heading', () => {
    expect(embeddingText({ gameName: 'G', contentName: 'C', headingPath: [], text: 'Body.' })).toBe(
      'Game: G\nContent: C\n\nBody.',
    );
  });
});

describe('chunkVectorMetadata', () => {
  it('carries the filter ids, provenance, location and body of the chunk', () => {
    expect(chunkVectorMetadata(chunk(), 'Each player takes 45 trains.')).toEqual({
      gameId: 'g_1',
      editionId: 'e_1',
      contentId: 'c_base',
      documentId: 'doc_1',
      authority: 'OFFICIAL_RULES',
      sourceType: 'RULEBOOK',
      headingPath: ['Setup', 'Trains'],
      pageStart: 2,
      pageEnd: 3,
      text: 'Each player takes 45 trains.',
    });
  });

  it('includes the document version only when the chunk has one', () => {
    expect(chunkVectorMetadata(chunk({ documentVersion: 'v2' }), 'x').documentVersion).toBe('v2');
    expect('documentVersion' in chunkVectorMetadata(chunk(), 'x')).toBe(false);
  });
});
