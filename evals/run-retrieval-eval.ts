/**
 * Full retrieval eval against dev (on demand; not run in CI, see README).
 *
 *   source scripts/dev-env.sh && pnpm -C evals eval:retrieval [--markdown] [--games seti,wingspan] [--dimensions 512]
 *
 * Without --dimensions it queries the deployed S3 Vectors index. With it, it
 * re-embeds the eval games' current chunks with Titan at that dimension into
 * an exact in-memory index and queries that instead (the dimension comparison).
 *
 * --rerank [key] reranks each case's candidates with a model and scores the whole reordered
 * list; --route also classifies each question and reports accuracy (not gated). Both cost
 * money and need --max-cost <usd>; paid runs need the operator's OK (see README).
 * Writes reports/retrieval-<timestamp>.json (gitignored).
 */
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadModelCatalog, modelFor } from '@bgr/ai';
import { loadDataset } from './src/dataset/case-schema.js';
import {
  createDevDocuments,
  createDevRetriever,
  createTitanEmbeddings,
  loadCorpus,
  loadEvalGames,
} from './src/live/aws.js';
import { buildLocalIndex } from './src/live/local-index.js';
import { checkModelFlags } from './src/cli-args.js';
import { estimateCostUsd } from './src/cost-meter.js';
import { createEvalModels } from './src/live/models.js';
import { toMarkdown } from './src/report/markdown.js';
import { resolveLiveGames, runEval } from './src/run-eval.js';
import { loadEvalConfig } from './src/scoring/aggregate.js';

// Rough per-call sizes for the pre-run estimate (eval estimates, not model config).
const ROUTER_INPUT_TOKENS = 300;
const ROUTER_OUTPUT_TOKENS = 20;
const RERANK_INPUT_TOKENS = 15 * 500 + 300;
const RERANK_OUTPUT_TOKENS = 80;

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
// `--rerank` takes an optional key: a bare flag means the catalog default.
const argv = process.argv.slice(2).flatMap((arg, i, all) => {
  const next = all[i + 1];
  return arg === '--rerank' && (next === undefined || next.startsWith('--'))
    ? [arg, 'default']
    : [arg];
});
const { values } = parseArgs({
  args: argv,
  options: {
    markdown: { type: 'boolean', default: false },
    games: { type: 'string' },
    dimensions: { type: 'string' },
    rerank: { type: 'string' },
    route: { type: 'boolean', default: false },
    'max-cost': { type: 'string' },
  },
});
const rerankRequested = values.rerank !== undefined;
const maxCost = checkModelFlags({
  ...(values.rerank !== undefined ? { rerank: values.rerank } : {}),
  route: values.route,
  ...(values['max-cost'] !== undefined ? { maxCost: values['max-cost'] } : {}),
});

const config = await loadEvalConfig(here('./config/eval.config.json'));
const games = await loadEvalGames();
const datasetDir = here('./datasets/retrieval/');
const files = (await readdir(datasetDir))
  .filter((f) => f.endsWith('.jsonl'))
  .map((f) => datasetDir + f);
const only = values.games?.split(',');
const cases = (await loadDataset(files)).filter((c) => !only || only.includes(c.game));

if (only) {
  const unknown = only.filter((g) => !(g in games));
  if (unknown.length > 0) throw new Error(`unknown --games ${unknown.join(', ')}`);
}
// Built before any network call, so a bad --dimensions fails straight away.
const localEmbeddings =
  values.dimensions === undefined ? undefined : createTitanEmbeddings(Number(values.dimensions));
const live = await resolveLiveGames(cases, games, createDevDocuments());

let retriever;
let index;
if (localEmbeddings) {
  const caseGames = new Set(cases.map((c) => c.game));
  const used = Object.fromEntries(Object.entries(games).filter(([k]) => caseGames.has(k)));
  const corpus = Object.values(await loadCorpus(used)).flat();
  retriever = createDevRetriever(config.topK, {
    index: await buildLocalIndex(corpus, localEmbeddings),
    embeddings: localEmbeddings,
  });
  index = `local index, ${localEmbeddings.dimensions} dimensions (${corpus.length} chunks re-embedded)`;
} else {
  retriever = createDevRetriever(config.topK);
  index = 'live S3 Vectors index';
}

const rerankKey = values.rerank === 'default' ? undefined : values.rerank;
const wired =
  maxCost === undefined
    ? undefined
    : createEvalModels({
        maxUsd: maxCost,
        rerank: rerankRequested,
        rerankKey,
        route: values.route,
        rerankTopN: config.rerankTopN,
      });
if (wired) {
  const catalog = loadModelCatalog();
  const plans = [
    ...(rerankRequested
      ? [
          {
            entry: modelFor(catalog, 'reranker', rerankKey),
            calls: cases.length,
            inputTokensPerCall: RERANK_INPUT_TOKENS,
            outputTokensPerCall: RERANK_OUTPUT_TOKENS,
          },
        ]
      : []),
    ...(values.route
      ? [
          {
            entry: modelFor(catalog, 'router'),
            calls: cases.length,
            inputTokensPerCall: ROUTER_INPUT_TOKENS,
            outputTokensPerCall: ROUTER_OUTPUT_TOKENS,
          },
        ]
      : []),
  ];
  const planned = plans.reduce((sum, p) => sum + p.calls, 0);
  process.stdout.write(
    `planned model calls: ${planned}; estimated cost ≈ $${estimateCostUsd(plans).toFixed(4)} (cap $${maxCost})\n`,
  );
}

const result = await runEval({
  cases,
  games: live,
  retriever,
  config,
  ...(wired ? { meter: wired.meter, ranker: wired.ranker, classifier: wired.classifier } : {}),
});
const report = {
  index,
  ...result,
  ...(wired
    ? {
        models: wired.models,
        promptVersions: wired.promptVersions,
        modelCost: {
          usd: wired.meter.spentUsd,
          calls: wired.meter.calls,
          inputTokens: wired.meter.inputTokens,
          outputTokens: wired.meter.outputTokens,
        },
      }
    : {}),
};
await mkdir(here('./reports/'), { recursive: true });
const out = here(`./reports/retrieval-${report.generatedAt.replace(/[:.]/g, '-')}.json`);
await writeFile(out, JSON.stringify(report, null, 2) + '\n');
process.stdout.write(`${cases.length} cases → ${out}\n`);
if (values.markdown) process.stdout.write('\n' + toMarkdown(report, index));
