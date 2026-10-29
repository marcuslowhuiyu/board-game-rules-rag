import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { RoutingResult } from './routing.js';
import { K_VALUES, type CaseResult } from './score-case.js';

// k must be one of the cutoffs scoreCase computes; any other value would fail every case.
const BarSchema = z.object({
  k: z.union(K_VALUES.map((k) => z.literal(k))),
  minRate: z.number().min(0).max(1),
});

export const EvalConfigSchema = z.object({
  /** Candidates the retriever returns per question. */
  topK: z.number().int().min(10).max(100),
  /** Games with fewer chunks than this are reported but left out of the tier bars. */
  smallCorpusThreshold: z.number().int().nonnegative(),
  bars: z.object({ simple: BarSchema, complex: BarSchema }),
});
export type EvalConfig = z.infer<typeof EvalConfigSchema>;

export async function loadEvalConfig(path: string): Promise<EvalConfig> {
  return EvalConfigSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}

export interface GameRow {
  game: string;
  chunks: number;
  smallCorpus: boolean;
  cases: number;
  emptyRetrievals: number;
  recallAt1: number;
  recallAt3: number;
  recallAt5: number;
  mrr: number;
  irrelevantRate: number;
  /** null when the game has no cases of that tier. */
  simplePassRate: number | null;
  complexFullCoverageRate: number | null;
}

export interface TierRow {
  /** Cases counted toward the bar (small-corpus games excluded). */
  cases: number;
  passRate: number;
  bar: number;
  passed: boolean;
}

export interface EvalReport {
  generatedAt: string;
  config: EvalConfig;
  games: GameRow[];
  tiers: { simple: TierRow; complex: TierRow };
  cases: CaseResult[];
  /** True when the cost cap stopped model calls before every case had them. */
  cutShort: boolean;
  /** Cases whose rerank call failed and fell back to retrieval-score order. */
  rerankFallbacks: number;
  /** Present when the router ran; reported, not gated. */
  routing?: RoutingResult;
  /** Added by the CLI. */
  models?: Record<string, { key: string; modelId: string }>;
  promptVersions?: Record<string, string>;
  modelCost?: { usd: number; calls: number; inputTokens: number; outputTokens: number };
}

const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

export function aggregate(
  results: CaseResult[],
  corpusSize: Record<string, number>,
  config: EvalConfig,
): EvalReport {
  const passes = (r: CaseResult) => r.fullCoverageAt[config.bars[r.tier].k];
  const isSmall = (game: string) => (corpusSize[game] ?? 0) < config.smallCorpusThreshold;
  const passRate = (rs: CaseResult[]) =>
    rs.length === 0 ? null : rs.filter(passes).length / rs.length;

  const gameKeys = [...new Set(results.map((r) => r.game))].sort();
  const games: GameRow[] = gameKeys.map((game) => {
    const rs = results.filter((r) => r.game === game);
    return {
      game,
      chunks: corpusSize[game] ?? 0,
      smallCorpus: isSmall(game),
      cases: rs.length,
      emptyRetrievals: rs.filter((r) => r.retrieved === 0).length,
      recallAt1: mean(rs.map((r) => r.recallAt[1])),
      recallAt3: mean(rs.map((r) => r.recallAt[3])),
      recallAt5: mean(rs.map((r) => r.recallAt[5])),
      mrr: mean(rs.map((r) => r.reciprocalRank)),
      irrelevantRate: mean(rs.map((r) => r.irrelevantTop5)),
      simplePassRate: passRate(rs.filter((r) => r.tier === 'simple')),
      complexFullCoverageRate: passRate(rs.filter((r) => r.tier === 'complex')),
    };
  });

  const tier = (name: 'simple' | 'complex'): TierRow => {
    const counted = results.filter((r) => r.tier === name && !isSmall(r.game));
    const rate = passRate(counted) ?? 0;
    const bar = config.bars[name].minRate;
    // Compare with a small tolerance so 9/10 meets a 0.9 bar despite float error.
    return {
      cases: counted.length,
      passRate: rate,
      bar,
      passed: counted.length > 0 && rate >= bar - 1e-9,
    };
  };

  return {
    generatedAt: new Date().toISOString(),
    config,
    games,
    tiers: { simple: tier('simple'), complex: tier('complex') },
    cases: results,
    cutShort: false,
    rerankFallbacks: 0,
  };
}
