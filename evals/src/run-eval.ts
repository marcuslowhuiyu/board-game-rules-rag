import { asContentId, asEditionId, asGameId } from '@bgr/domain';
import type { DocumentsRepository } from '@bgr/persistence';
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

/**
 * Checks the eval games against the live documents table before a run: every
 * game and content package the cases use must still have CURRENT documents,
 * or a deleted or re-created game would silently score zeros. Also replaces
 * the chunk count written at ingest with the live one (CURRENT documents in
 * the referenced content), which decides the small-corpus exclusion.
 */
export async function resolveLiveGames(
  cases: readonly RetrievalCase[],
  games: EvalGames,
  documents: Pick<DocumentsRepository, 'listDocumentsForEdition'>,
): Promise<EvalGames> {
  const out: EvalGames = { ...games };
  for (const key of new Set(cases.map((c) => c.game))) {
    const game = games[key];
    if (!game) throw new EvalConfigError(`unknown game "${key}" in the dataset`);
    const slugs = new Set(cases.filter((c) => c.game === key).flatMap((c) => c.enabledContent));
    const current = (
      await documents.listDocumentsForEdition(asGameId(game.gameId), asEditionId(game.editionId))
    ).filter((d) => d.status === 'CURRENT');
    let chunks = 0;
    for (const slug of slugs) {
      const contentId = game.content[slug];
      const docs = current.filter((d) => d.contentId === contentId);
      if (docs.length === 0) {
        throw new EvalConfigError(
          `game "${key}" (${game.gameId} / ${game.editionId}) has no CURRENT documents in content ${slug}; re-run eval:ingest`,
        );
      }
      chunks += docs.reduce((sum, d) => sum + d.chunkCount, 0);
    }
    out[key] = { ...game, chunks };
  }
  return out;
}
