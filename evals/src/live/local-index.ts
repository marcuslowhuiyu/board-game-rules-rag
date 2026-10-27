import type { EmbeddingsProvider } from '@bgr/ai';
import type { Chunk } from '@bgr/domain';
import { chunkVectorMetadata, embeddingText, InMemoryVectorIndex } from '@bgr/retrieval';

/** One ingested chunk with its body and the names its embedding header uses. */
export interface CorpusChunk {
  chunk: Chunk;
  text: string;
  gameName: string;
  contentName: string;
}

/**
 * Re-embeds an ingested corpus into an exact in-memory index, using the same
 * embedding text and metadata as the EMBED stage. This lets the eval compare
 * embedding settings (such as 512 vs 1024 dimensions) on identical chunks
 * without deploying a second vector index.
 */
export async function buildLocalIndex(
  corpus: readonly CorpusChunk[],
  embeddings: EmbeddingsProvider,
): Promise<InMemoryVectorIndex> {
  const { vectors } = await embeddings.embed(
    corpus.map((c) =>
      embeddingText({
        gameName: c.gameName,
        contentName: c.contentName,
        headingPath: c.chunk.headingPath,
        text: c.text,
      }),
    ),
  );
  const index = new InMemoryVectorIndex();
  await index.putVectors(
    corpus.map((c, i) => ({
      key: c.chunk.chunkId,
      vector: vectors[i]!,
      metadata: chunkVectorMetadata(c.chunk, c.text),
    })),
  );
  return index;
}
