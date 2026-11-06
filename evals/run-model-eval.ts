/**
 * Answer eval against dev (on demand and paid; not run in CI, see README).
 *
 *   source scripts/dev-env.sh && pnpm -C evals eval:answer --max-cost 1 [--answerer a,b] \
 *     [--reranker key] [--games seti] [--cases id,id] [--labelled-tier] [--markdown]
 *
 * Runs the real answer pipeline in process (no API, no daily cap) once per answerer key and
 * scores each answer deterministically. Every key is checked and the estimated cost printed
 * before any model call; the run stops at --max-cost. Paid runs need the operator's OK.
 * Writes reports/answer-<generatedAt>.json per answerer (gitignored).
 */
import { access, mkdir, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadModelCatalog } from '@bgr/ai';
import { formatRunPlan, resolveRunPlan } from './src/cli-args.js';
import { CostMeter } from './src/cost-meter.js';
import { loadAnswerDataset } from './src/dataset/answer-case-schema.js';
import { createEvalAnswerPipeline } from './src/live/answer-pipeline.js';
import { loadEvalGames } from './src/live/aws.js';
import { toAnswerMarkdown } from './src/report/answer-markdown.js';
import { runAnswerEval, tierLookup, type AnswerRunReport } from './src/run-answer-eval.js';
import { loadEvalConfig } from './src/scoring/aggregate.js';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

async function jsonlFiles(dir: string): Promise<string[]> {
  try {
    await access(dir);
  } catch {
    return [];
  }
  return (await readdir(dir)).filter((f) => f.endsWith('.jsonl')).map((f) => dir + f);
}

const catalog = loadModelCatalog();
// Unknown or unapproved keys and a missing --max-cost fail here, before anything else.
const plan = resolveRunPlan(process.argv.slice(2), catalog);

const config = await loadEvalConfig(here('./config/eval.config.json'));
const games = await loadEvalGames();
if (plan.games) {
  const unknown = plan.games.filter((g) => !(g in games));
  if (unknown.length > 0) throw new Error(`unknown --games ${unknown.join(', ')}`);
}
const all = await loadAnswerDataset(
  await jsonlFiles(here('./datasets/retrieval/')),
  await jsonlFiles(here('./datasets/answer-only/')),
);
if (plan.caseIds) {
  const known = new Set(all.map((c) => c.case.id));
  const unknown = plan.caseIds.filter((id) => !known.has(id));
  if (unknown.length > 0) throw new Error(`unknown --cases ${unknown.join(', ')}`);
}
const cases = all.filter(
  ({ case: c }) =>
    (!plan.games || plan.games.includes(c.game)) && (!plan.caseIds || plan.caseIds.includes(c.id)),
);
if (cases.length === 0) throw new Error('no answer cases match the filters');

process.stdout.write(formatRunPlan(plan, catalog, cases.length) + '\n');

// One cap for the whole comparison: a later model's run starts cut short once it is spent.
const meter = new CostMeter(plan.maxCost);
const tierFor = plan.labelledTier ? tierLookup(cases) : undefined;
const reports: AnswerRunReport[] = [];
await mkdir(here('./reports/'), { recursive: true });
for (const answerer of plan.answererKeys) {
  const wired = createEvalAnswerPipeline({
    keys: { answerer, ...(plan.rerankerKey ? { reranker: plan.rerankerKey } : {}) },
    config,
    catalog,
    ...(tierFor ? { tierFor } : {}),
  });
  const report = await runAnswerEval({
    cases,
    games,
    pipeline: wired.pipeline,
    models: wired.models,
    promptVersions: wired.promptVersions,
    meter,
    bars: config.answerBars,
    labelledTier: plan.labelledTier,
    filters: {
      ...(plan.games ? { games: plan.games } : {}),
      ...(plan.caseIds ? { caseIds: plan.caseIds } : {}),
    },
  });
  reports.push(report);
  const out = here(`./reports/answer-${report.generatedAt.replace(/[:.]/g, '-')}.json`);
  await writeFile(out, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(
    `${answerer}: ${report.cases.length}/${cases.length} cases, $${report.cost.usd.toFixed(4)}, ${report.summary.verdict} → ${out}\n`,
  );
}
if (plan.markdown) process.stdout.write('\n' + toAnswerMarkdown(reports));
