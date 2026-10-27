/**
 * Checks every evidence phrase against the eval games' ingested chunks.
 *
 *   source scripts/dev-env.sh && pnpm -C evals exec tsx scripts/verify-dataset.ts
 *
 * Exits 1 when any case has an issue.
 */
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadDataset } from '../src/dataset/case-schema.js';
import { verifyDataset } from '../src/dataset/verify.js';
import { loadEvalGames, loadGameChunks } from '../src/live/aws.js';

const dir = fileURLToPath(new URL('../datasets/retrieval/', import.meta.url));
const files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl')).map((f) => dir + f);
const cases = await loadDataset(files);
const chunks = await loadGameChunks(await loadEvalGames());
const issues = verifyDataset(cases, chunks);
for (const i of issues) process.stdout.write(`${i.caseId}  ${i.itemKey}  ${i.problem}\n`);
process.stdout.write(`${cases.length} cases, ${issues.length} issues\n`);
process.exit(issues.length === 0 ? 0 : 1);
