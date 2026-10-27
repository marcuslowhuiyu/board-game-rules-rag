import type { Chunk } from '@bgr/domain';
import type { ChunkVectorMetadata } from './vector-index.js';

/**
 * The text embedded for a chunk. A short header gives the vector its game and
 * section context (MASTER_PLAN §15), so a chunk that never names its game or
 * section still matches questions that do. Shared by the ingestion EMBED stage
 * and the eval's local index, so both embed the same text.
 */
export function embeddingText(input: {
  gameName: string;
  contentName: string;
  headingPath: readonly string[];
  text: string;
}): string {
  const lines = [`Game: ${input.gameName}`, `Content: ${input.contentName}`];
  if (input.headingPath.length > 0) lines.push(`Section: ${input.headingPath.join(' > ')}`);
  return `${lines.join('\n')}\n\n${input.text}`;
}

/** The metadata stored with a chunk's vector; `text` is the chunk body. */
export function chunkVectorMetadata(chunk: Chunk, text: string): ChunkVectorMetadata {
  return {
    gameId: chunk.gameId,
    editionId: chunk.editionId,
    contentId: chunk.contentId,
    documentId: chunk.documentId,
    authority: chunk.authority,
    sourceType: chunk.sourceType,
    headingPath: chunk.headingPath,
    pageStart: chunk.pageStart,
    pageEnd: chunk.pageEnd,
    text,
    ...(chunk.documentVersion !== undefined ? { documentVersion: chunk.documentVersion } : {}),
  };
}
