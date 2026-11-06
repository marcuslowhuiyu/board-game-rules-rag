import type { ModelRole, QuestionTier } from '@bgr/ai';
import { isRejectedRuling } from '@bgr/answering';
import { asContentId, asEditionId, asGameId, type RulesAnswer } from '@bgr/domain';
import type { RetrievalQuery } from '@bgr/retrieval';
import type { CostMeter } from './cost-meter.js';
import type { AnswerCase } from './dataset/answer-case-schema.js';
import type { EvalPipeline } from './live/answer-pipeline.js';
import { EvalConfigError, type EvalGames } from './run-eval.js';
import {
  aggregateAnswers,
  type AnswerBars,
  type AnswerSummary,
} from './scoring/aggregate-answers.js';
import { scoreAnswerCase, type AnswerCaseScore, type AnswerRun } from './scoring/score-answer.js';

export type AnswerCaseRow = AnswerCaseScore & {
  latencyMs: number;
  costUsd: number;
  /** Absent on an error row. */
  answer?: RulesAnswer;
  /** Text of the passages the applied ruling cites. */
  citedText?: string[];
};

export interface AnswerRunReport {
  generatedAt: string;
  /** True when every question got its labelled tier and the router was not called. */
  labelledTier: boolean;
  /** The --games and --cases filters of the run; null when not filtered. */
  filters: { games: string[] | null; caseIds: string[] | null };
  bars: AnswerBars;
  models: Record<ModelRole, { key: string; modelId: string }>;
  promptVersions: Record<ModelRole, string>;
  cases: AnswerCaseRow[];
  summary: AnswerSummary;
  cost: {
    usd: number;
    calls: number;
    /** Total cost over the questions attempted. */
    perQuestionUsd: number;
    /** Over the cases that ran, errors included. */
    p50LatencyMs: number;
    p95LatencyMs: number;
  };
  /** True when `--max-cost` stopped the run before every case ran. */
  cutShort: boolean;
}

/**
 * Question text → labelled tier, for labelled-tier runs. Questions are unique per game; the same
 * text in two games with different tiers would make the lookup ambiguous, so it throws.
 */
export function tierLookup(cases: readonly AnswerCase[]): (question: string) => QuestionTier {
  const tiers = new Map<string, QuestionTier>();
  for (const { case: c } of cases) {
    const seen = tiers.get(c.question);
    if (seen !== undefined && seen !== c.tier) {
      throw new EvalConfigError(
        `question has different labelled tiers in two games: ${c.question}`,
      );
    }
    tiers.set(c.question, c.tier);
  }
  return (question) => {
    const tier = tiers.get(question);
    if (tier === undefined) throw new Error(`no labelled tier for question: ${question}`);
    return tier;
  };
}

/** Nearest-rank percentile; 0 for no values. */
function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause =
    error.cause instanceof Error ? ` (${error.cause.name}: ${error.cause.message})` : '';
  return `${error.name}: ${error.message}${cause}`;
}

/**
 * Runs the answer cases through the pipeline one at a time and scores them. Every case's game
 * and content are resolved before the first question. Before each case an exhausted meter stops
 * the run (`cutShort`, verdict `incomplete`). A case whose run throws is an error row, and the run
 * goes on to the next case. So is a case whose answerer output was unusable, or whose ruling
 * validation rejected: the pipeline then answers INCONCLUSIVE, which would otherwise score as right
 * on a not-in-rulebook case.
 */
export async function runAnswerEval(input: {
  cases: readonly AnswerCase[];
  games: EvalGames;
  pipeline: EvalPipeline;
  models: AnswerRunReport['models'];
  promptVersions: AnswerRunReport['promptVersions'];
  meter: CostMeter;
  bars: AnswerBars;
  labelledTier: boolean;
  filters?: { games?: string[]; caseIds?: string[] };
  now?: () => number;
}): Promise<AnswerRunReport> {
  const { cases, games, pipeline, meter } = input;
  const now = input.now ?? Date.now;
  const generatedAt = new Date(now()).toISOString();

  const queries: RetrievalQuery[] = cases.map(({ case: c }) => {
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

  const rows: AnswerCaseRow[] = [];
  let cutShort = false;
  let calls = 0;
  for (const [i, c] of cases.entries()) {
    if (meter.exhausted) {
      cutShort = true;
      break;
    }
    let costUsd = 0;
    const started = now();
    let run: AnswerRun;
    let answer: RulesAnswer | undefined;
    let citedText: string[] | undefined;
    let answererFailure: string | undefined;
    let answererOk = false;
    try {
      // Every call, failed ones included, reaches the meter, also when the run then throws.
      const outcome = await pipeline.answer(
        { query: queries[i]!, correlationId: `eval-${c.case.id}` },
        (record) => {
          meter.record(record);
          costUsd += record.costUsd;
          calls += 1;
          if (record.role === 'answerer') {
            if (record.ok) answererOk = true;
            else answererFailure = record.error ?? 'unknown error';
          }
        },
      );
      if (answererFailure !== undefined && !answererOk) {
        throw new Error(`answerer output unusable: ${answererFailure}`);
      }
      if (isRejectedRuling(outcome.answer)) {
        throw new Error('answerer ruling rejected: it could not be checked against the passages');
      }
      run = { answer: outcome.answer, passages: outcome.passages, tier: outcome.tier };
      answer = outcome.answer;
      const cited = new Set(outcome.answer.evidence.map((e) => e.chunkId));
      citedText = outcome.passages.filter((p) => cited.has(p.chunkId)).map((p) => p.text);
    } catch (error) {
      run = { error: describeError(error) };
    }
    rows.push({
      ...scoreAnswerCase(c, run),
      latencyMs: now() - started,
      costUsd,
      ...(answer ? { answer } : {}),
      ...(citedText ? { citedText } : {}),
    });
  }

  const usd = rows.reduce((sum, r) => sum + r.costUsd, 0);
  const latencies = rows.map((r) => r.latencyMs);
  return {
    generatedAt,
    labelledTier: input.labelledTier,
    filters: {
      games: input.filters?.games ?? null,
      caseIds: input.filters?.caseIds ?? null,
    },
    bars: input.bars,
    models: input.models,
    promptVersions: input.promptVersions,
    cases: rows,
    summary: aggregateAnswers(rows, input.bars, { cutShort }),
    cost: {
      usd,
      calls,
      perQuestionUsd: rows.length === 0 ? 0 : usd / rows.length,
      p50LatencyMs: percentile(latencies, 50),
      p95LatencyMs: percentile(latencies, 95),
    },
    cutShort,
  };
}
