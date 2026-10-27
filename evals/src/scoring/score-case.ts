import type { RetrievedChunk } from '@bgr/retrieval';
import type { RetrievalCase } from '../dataset/case-schema.js';
import { evidenceMatches } from './match.js';

export const K_VALUES = [1, 3, 5, 10] as const;
export type K = (typeof K_VALUES)[number];

export interface CaseResult {
  id: string;
  game: string;
  tier: RetrievalCase['tier'];
  /** Chunks the retriever returned. */
  retrieved: number;
  /** 1-based best rank per item key (required and supporting); null if not retrieved. */
  itemRanks: Record<string, number | null>;
  /** Share of required items found within the top k. */
  recallAt: Record<K, number>;
  /** True when every required item is within the top k. */
  fullCoverageAt: Record<K, boolean>;
  /** 1 / rank of the first required item, else 0. */
  reciprocalRank: number;
  /** Share of the top-5 chunks that match no item of the case. */
  irrelevantTop5: number;
}

export function scoreCase(c: RetrievalCase, ranked: readonly RetrievedChunk[]): CaseResult {
  const itemRanks: Record<string, number | null> = {};
  for (const item of c.requiredEvidence) {
    const index = ranked.findIndex((chunk) => evidenceMatches(item, chunk));
    itemRanks[item.key] = index === -1 ? null : index + 1;
  }

  const requiredRanks = c.requiredEvidence
    .filter((e) => e.required)
    .map((e) => itemRanks[e.key] ?? null);
  const within = (k: number) => requiredRanks.filter((r) => r !== null && r <= k).length;
  const recallAt = {} as Record<K, number>;
  const fullCoverageAt = {} as Record<K, boolean>;
  for (const k of K_VALUES) {
    recallAt[k] = within(k) / requiredRanks.length;
    fullCoverageAt[k] = within(k) === requiredRanks.length;
  }

  const found = requiredRanks.filter((r): r is number => r !== null);
  const top5 = ranked.slice(0, 5);
  const irrelevant = top5.filter(
    (chunk) => !c.requiredEvidence.some((item) => evidenceMatches(item, chunk)),
  ).length;

  return {
    id: c.id,
    game: c.game,
    tier: c.tier,
    retrieved: ranked.length,
    itemRanks,
    recallAt,
    fullCoverageAt,
    reciprocalRank: found.length === 0 ? 0 : 1 / Math.min(...found),
    irrelevantTop5: top5.length === 0 ? 0 : irrelevant / top5.length,
  };
}
