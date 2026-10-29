import type { PassageRanker } from '@bgr/ai';
import type { Logger } from '@bgr/shared';
import type { RetrievedChunk } from './vector-rules-retriever.js';

export interface RerankOutcome {
  ranked: RetrievedChunk[];
  /** True when the ranker failed and the candidates are in retrieval-score order. */
  fallback: boolean;
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
  if (candidates.length === 0) return { ranked: [], fallback: false };

  let orderedIds: string[];
  try {
    const result = await ranker.rank(
      question,
      candidates.map((c) => ({ id: c.chunkId, text: c.text, headingPath: c.headingPath })),
      options.correlationId,
    );
    orderedIds = result.orderedIds;
  } catch (error) {
    options.logger?.warn('reranker failed; using retrieval score order', {
      correlationId: options.correlationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ranked: byScoreDescending(candidates), fallback: true };
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
  for (const chunk of byScoreDescending(candidates)) {
    if (!seen.has(chunk.chunkId)) {
      seen.add(chunk.chunkId);
      ranked.push(chunk);
    }
  }
  return { ranked, fallback: false };
}
