import { asContentId, asEditionId, asGameId } from '@bgr/domain';
import type { DocumentsRepository } from '@bgr/persistence';
import type { PassageRanker, QuestionClassifier, QuestionTier } from '@bgr/ai';
import {
  rerankEvidence,
  routeQuestion,
  type RouteOutcome,
  type RulesRetriever,
} from '@bgr/retrieval';
import type { RetrievalCase } from './dataset/case-schema.js';
import { aggregate, type EvalConfig, type EvalReport } from './scoring/aggregate.js';
import { reasonOf, scoreRouting } from './scoring/routing.js';
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
  /** Optional model steps. Each case's calls stop once the meter is exhausted. */
  meter?: { readonly exhausted: boolean };
  ranker?: PassageRanker;
  classifier?: QuestionClassifier;
}): Promise<EvalReport> {
  const { cases, games, retriever, config, meter, ranker, classifier } = input;

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
  const routedExpected: QuestionTier[] = [];
  const routed: RouteOutcome[] = [];
  let cutShort = false;
  let rerankFallbacks = 0;
  let rerankedCases = 0;
  let placedTotal = 0;
  let expectedPlacements = 0;
  let candidatesTotal = 0;
  const rerankFallbackReasons: Record<string, number> = {};
  for (const [i, c] of cases.entries()) {
    let ranked = await retriever.retrieve(queries[i]!);
    // The meter is checked before each call; rerank swallows model errors, but
    // every call, failed or not, reaches the meter through the model's sink.
    let rerankState: NonNullable<CaseResult['rerank']> = 'skipped';
    let rerankPlaced = 0;
    let rerankCandidates = 0;
    let rerankError: string | undefined;
    if (ranker) {
      if (meter?.exhausted) {
        cutShort = true;
      } else {
        const outcome = await rerankEvidence(c.question, ranked, ranker);
        ranked = outcome.ranked;
        rerankCandidates = ranked.length;
        if (outcome.fallback) {
          rerankState = 'fallback';
          rerankFallbacks += 1;
          rerankError = outcome.error;
          const reason = reasonOf(outcome.error);
          rerankFallbackReasons[reason] = (rerankFallbackReasons[reason] ?? 0) + 1;
        } else {
          rerankState = 'reranked';
          rerankPlaced = outcome.placed;
          rerankedCases += 1;
          placedTotal += outcome.placed;
          expectedPlacements += Math.min(config.rerankTopN, rerankCandidates);
          candidatesTotal += rerankCandidates;
        }
      }
    }
    // Routing is reported only; the case's labelled tier is what scores it.
    let wasRouted = false;
    if (classifier) {
      if (meter?.exhausted) {
        cutShort = true;
      } else {
        routed.push(await routeQuestion(c.question, classifier));
        routedExpected.push(c.tier);
        wasRouted = true;
      }
    }
    results.push({
      ...scoreCase(c, ranked),
      rerank: rerankState,
      rerankPlaced,
      rerankCandidates,
      ...(rerankError === undefined ? {} : { rerankError }),
      routed: wasRouted,
    });
  }

  const corpusSize = Object.fromEntries(Object.entries(games).map(([k, g]) => [k, g.chunks]));
  const report = aggregate(results, corpusSize, config);
  return {
    ...report,
    cutShort,
    rerankFallbacks,
    rerankRequested: ranker !== undefined,
    rerankedCases,
    placedTotal,
    expectedPlacements,
    candidatesTotal,
    rerankFallbackReasons,
    ...(classifier ? { routing: scoreRouting(routedExpected, routed) } : {}),
  };
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
