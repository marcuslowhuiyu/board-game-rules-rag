/**
 * Full retrieval eval against dev (on demand; not run in CI, see README).
 *
 *   source scripts/dev-env.sh && pnpm -C evals eval:retrieval [--markdown] [--games seti,wingspan]
 *
 * Writes reports/retrieval-<timestamp>.json (gitignored).
 */
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadDataset } from './src/dataset/case-schema.js';
import { createDevRetriever, loadEvalGames } from './src/live/aws.js';
import { toMarkdown } from './src/report/markdown.js';
import { runEval } from './src/run-eval.js';
import { loadEvalConfig } from './src/scoring/aggregate.js';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const { values } = parseArgs({
  options: { markdown: { type: 'boolean', default: false }, games: { type: 'string' } },
});

const config = await loadEvalConfig(here('./config/eval.config.json'));
const games = await loadEvalGames();
const datasetDir = here('./datasets/retrieval/');
const files = (await readdir(datasetDir))
  .filter((f) => f.endsWith('.jsonl'))
  .map((f) => datasetDir + f);
const only = values.games?.split(',');
const cases = (await loadDataset(files)).filter((c) => !only || only.includes(c.game));

const report = await runEval({ cases, games, retriever: createDevRetriever(config.topK), config });
await mkdir(here('./reports/'), { recursive: true });
const out = here(`./reports/retrieval-${report.generatedAt.replace(/[:.]/g, '-')}.json`);
await writeFile(out, JSON.stringify(report, null, 2) + '\n');
console.log(`${cases.length} cases → ${out}`);
if (values.markdown) console.log('\n' + toMarkdown(report));
