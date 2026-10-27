import type { RetrievedChunk } from './vector-rules-retriever.js';

/**
 * Trims retrieval candidates (10–15) to the evidence passed to the model
 * (4–8, MASTER_PLAN §21). The initial reducer simply keeps the top `max` by
 * score. MMR or a reranker replaces it only if the M3 / M7 evals show a gain.
 */
export function selectEvidence(
  candidates: readonly RetrievedChunk[],
  max: number,
): RetrievedChunk[] {
  return [...candidates].sort((a, b) => b.score - a.score).slice(0, max);
}
