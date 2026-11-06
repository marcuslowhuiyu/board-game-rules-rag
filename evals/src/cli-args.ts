import { parseArgs } from 'node:util';
import { modelFor, type ModelCatalog } from '@bgr/ai';
import { ESTIMATE_TOKENS, estimateCostUsd } from './cost-meter.js';

/**
 * Model calls cost money, so `--rerank`, `--route` and the answer eval need an explicit cap.
 * Returns the cap in USD, or undefined when the run makes no model calls.
 */
export function checkModelFlags(values: {
  rerank?: boolean | string;
  route?: boolean;
  /** The answer eval always calls models. */
  answer?: boolean;
  maxCost?: string;
}): number | undefined {
  const usesModels = values.rerank !== undefined || values.route === true;
  if (values.maxCost === undefined) {
    if (values.answer === true) throw new Error('eval:answer requires --max-cost <usd>');
    if (usesModels) throw new Error('--rerank and --route require --max-cost <usd>');
    return undefined;
  }
  const max = Number(values.maxCost);
  if (!Number.isFinite(max) || max < 0) {
    throw new Error(`--max-cost must be a non-negative number of USD; got "${values.maxCost}"`);
  }
  return max;
}

export interface AnswerRunPlan {
  /** One run per key, in order. */
  answererKeys: string[];
  rerankerKey?: string;
  games?: string[];
  caseIds?: string[];
  labelledTier: boolean;
  markdown: boolean;
  maxCost: number;
}

const list = (value: string | undefined): string[] | undefined =>
  value
    ?.split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

/**
 * The answer eval's flags, checked before anything is called: `--max-cost` is required, and every
 * `--answerer` and `--reranker` key must be approved for its role in the catalog.
 */
export function resolveRunPlan(args: readonly string[], catalog: ModelCatalog): AnswerRunPlan {
  const { values } = parseArgs({
    args: [...args],
    options: {
      answerer: { type: 'string' },
      reranker: { type: 'string' },
      games: { type: 'string' },
      cases: { type: 'string' },
      'labelled-tier': { type: 'boolean', default: false },
      markdown: { type: 'boolean', default: false },
      'max-cost': { type: 'string' },
    },
  });
  const maxCost = checkModelFlags({
    answer: true,
    ...(values['max-cost'] !== undefined ? { maxCost: values['max-cost'] } : {}),
  }) as number;
  const answererKeys = list(values.answerer) ?? [catalog.defaults.answerer];
  if (answererKeys.length === 0) throw new Error('--answerer needs at least one model key');
  for (const key of answererKeys) modelFor(catalog, 'answerer', key);
  if (values.reranker !== undefined) modelFor(catalog, 'reranker', values.reranker);
  const games = list(values.games);
  const caseIds = list(values.cases);
  return {
    answererKeys,
    ...(values.reranker !== undefined ? { rerankerKey: values.reranker } : {}),
    ...(games ? { games } : {}),
    ...(caseIds ? { caseIds } : {}),
    labelledTier: values['labelled-tier'],
    markdown: values.markdown,
    maxCost,
  };
}

/** Rough cost of the whole plan: per question, a router call (unless labelled-tier), a rerank and an answer, per answerer. */
export function estimateAnswerRunUsd(
  plan: AnswerRunPlan,
  catalog: ModelCatalog,
  questions: number,
): number {
  const call = (entry: ReturnType<typeof modelFor>, tokens: { input: number; output: number }) => ({
    entry,
    calls: questions,
    inputTokensPerCall: tokens.input,
    outputTokensPerCall: tokens.output,
  });
  return plan.answererKeys.reduce(
    (sum, key) =>
      sum +
      estimateCostUsd([
        ...(plan.labelledTier ? [] : [call(modelFor(catalog, 'router'), ESTIMATE_TOKENS.router)]),
        call(modelFor(catalog, 'reranker', plan.rerankerKey), ESTIMATE_TOKENS.reranker),
        call(modelFor(catalog, 'answerer', key), ESTIMATE_TOKENS.answerer),
      ]),
    0,
  );
}

export function formatRunPlan(
  plan: AnswerRunPlan,
  catalog: ModelCatalog,
  questions: number,
): string {
  const usd = estimateAnswerRunUsd(plan, catalog, questions);
  const line = `planned questions: ${questions} × ${plan.answererKeys.length} models; estimated cost ≈ $${usd.toFixed(4)} (cap $${plan.maxCost})`;
  return usd > plan.maxCost
    ? `${line}\nwarning: the estimate is over the cap, so the run will likely be cut short and incomplete`
    : line;
}
