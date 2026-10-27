import { asContentId, asEditionId, asGameId } from '@bgr/domain';
import type { RulesRetriever } from '@bgr/retrieval';
import type { RetrievalCase } from './dataset/case-schema.js';
import { aggregate, type EvalConfig, type EvalReport } from './scoring/aggregate.js';
import { scoreCase, type CaseResult } from './scoring/score-case.js';

/** Eval game ids per dataset game key, as written by the ingest script. */
export type EvalGames = Record<
  string,
  {
    gameId: string;
    editionId: string;
    /** Content slug (as used in cases) → contentId. */
    content: Record<string, string>;
    /** Chunks across the game's CURRENT documents. */
    chunks: number;
  }
>;

export class EvalConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvalConfigError';
  }
}

/**
 * Runs every case against the retriever, one at a time, and aggregates the
 * results. Every case's game and content are resolved before the first query,
 * so a stale config fails fast instead of scoring zeros.
 */
export async function runEval(input: {
  cases: readonly RetrievalCase[];
  games: EvalGames;
  retriever: RulesRetriever;
  config: EvalConfig;
}): Promise<EvalReport> {
  const { cases, games, retriever, config } = input;

  const queries = cases.map((c) => {
    const game = games[c.game];
    if (!game) throw new EvalConfigError(`unknown game "${c.game}" in case ${c.id}`);
    const enabledContentIds = c.enabledContent.map((slug) => {
      const contentId = game.content[slug];
      if (!contentId) {
        throw new EvalConfigError(`unknown content "${slug}" for game "${c.game}" in case ${c.id}`);
      }
      return asContentId(contentId);
    });
    return {
      gameId: asGameId(game.gameId),
      editionId: asEditionId(game.editionId),
      enabledContentIds,
      text: c.question,
    };
  });

  const results: CaseResult[] = [];
  for (const [i, c] of cases.entries()) {
    const ranked = await retriever.retrieve(queries[i]!);
    results.push(scoreCase(c, ranked));
  }

  const corpusSize = Object.fromEntries(Object.entries(games).map(([k, g]) => [k, g.chunks]));
  return aggregate(results, corpusSize, config);
}
