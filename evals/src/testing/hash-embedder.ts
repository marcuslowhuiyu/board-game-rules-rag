import type { EmbeddingResult, EmbeddingsProvider } from '@bgr/ai';

const DIMENSIONS = 256;

/** 32-bit FNV-1a. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Deterministic bag-of-words embedder for offline tests: each word of three
 * or more letters adds 1 to a hashed bucket, then the vector is normalised.
 * Similar wording scores close; it knows nothing about meaning.
 */
export class HashEmbedder implements EmbeddingsProvider {
  readonly modelId = 'hash-bow-v1';
  readonly dimensions = DIMENSIONS;

  async embed(texts: readonly string[]): Promise<EmbeddingResult> {
    const vectors = texts.map((text) => {
      const vec = new Array<number>(DIMENSIONS).fill(0);
      for (const token of text.toLowerCase().split(/[^a-z]+/)) {
        if (token.length >= 3) vec[fnv1a(token) % DIMENSIONS]! += 1;
      }
      const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0));
      return norm === 0 ? vec : vec.map((x) => x / norm);
    });
    return { vectors, inputTokens: 0 };
  }
}
