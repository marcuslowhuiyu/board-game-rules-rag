import {
  matchesFilter,
  type VectorHit,
  type VectorIndex,
  type VectorItem,
} from './vector-index.js';

/** Exact cosine search over an in-memory map, with S3 Vectors' pre-filter semantics. For tests and local runs. */
export class InMemoryVectorIndex implements VectorIndex {
  private readonly items = new Map<string, VectorItem>();

  async putVectors(items: readonly VectorItem[]): Promise<void> {
    for (const item of items) this.items.set(item.key, structuredClone(item));
  }

  async query(input: Parameters<VectorIndex['query']>[0]): Promise<VectorHit[]> {
    return Array.from(this.items.values())
      .filter((item) => matchesFilter(item.metadata, input.filter))
      .map((item) => ({
        key: item.key,
        score: cosine(input.vector, item.vector),
        metadata: structuredClone(item.metadata),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, input.topK);
  }
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * (b[i] ?? 0);
    na += a[i]! * a[i]!;
    nb += (b[i] ?? 0) * (b[i] ?? 0);
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}
