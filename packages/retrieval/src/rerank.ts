import type { PassageRanker } from '@bgr/ai';
import type { Logger } from '@bgr/shared';
import type { RetrievedChunk } from './vector-rules-retriever.js';

export interface RerankOutcome {
  ranked: RetrievedChunk[];
  /** True when the ranker failed and the candidates are in retrieval-score order. */
  fallback: boolean;
  /** Distinct known candidates the model ranked; 0 with `fallback: false` means the model placed nothing. */
  placed: number;
  /** Set when the ranker failed: the error name and message. */
  error?: string;
}

const byScoreDescending = (candidates: readonly RetrievedChunk[]): RetrievedChunk[] =>
  [...candidates].sort((a, b) => b.score - a.score);

/**
 * All candidates exactly once: the ranker's ids first (unknown and repeated
 * ids ignored), then the rest by retrieval score. A ranker failure never
 * throws; it falls back to score order.
 */
export async function rerankEvidence(
  question: string,
  candidates: readonly RetrievedChunk[],
  ranker: PassageRanker,
  options: { logger?: Logger; correlationId?: string } = {},
): Promise<RerankOutcome> {
  if (candidates.length === 0) return { ranked: [], fallback: false, placed: 0 };

  const failed = (error: string): RerankOutcome => {
    options.logger?.warn('reranker failed; using retrieval score order', {
      correlationId: options.correlationId,
      error,
    });
    return { ranked: byScoreDescending(candidates), fallback: true, placed: 0, error };
  };

  let orderedIds: string[];
  try {
    const result = await ranker.rank(
      question,
      candidates.map((c) => ({ id: c.chunkId, text: c.text, headingPath: c.headingPath })),
      options.correlationId,
    );
    if (!Array.isArray(result.orderedIds))
      return failed('InvalidRankerOutput: orderedIds is not an array');
    orderedIds = result.orderedIds;
  } catch (error) {
    return failed(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  }

  const byId = new Map(candidates.map((c) => [c.chunkId, c]));
  const ranked: RetrievedChunk[] = [];
  const seen = new Set<string>();
  for (const id of orderedIds) {
    const chunk = byId.get(id);
    if (chunk && !seen.has(id)) {
      seen.add(id);
      ranked.push(chunk);
    }
  }
  const placed = ranked.length;
  for (const chunk of byScoreDescending(candidates)) {
    if (!seen.has(chunk.chunkId)) {
      seen.add(chunk.chunkId);
      ranked.push(chunk);
    }
  }
  return { ranked, fallback: false, placed };
}
