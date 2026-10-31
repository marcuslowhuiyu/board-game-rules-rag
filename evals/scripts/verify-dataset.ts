/**
 * Checks every evidence phrase against the eval games' ingested chunks, and
 * that no not-in-rulebook case's forbidden claim is stated by a chunk.
 *
 *   source scripts/dev-env.sh && pnpm -C evals exec tsx scripts/verify-dataset.ts
 *
 * Exits 1 when any case has an issue.
 */
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadAnswerDataset } from '../src/dataset/answer-case-schema.js';
import { loadDataset } from '../src/dataset/case-schema.js';
import { verifyAnswerOnly, verifyDataset } from '../src/dataset/verify.js';
import { loadEvalGames, loadGameChunks } from '../src/live/aws.js';

const jsonlIn = async (sub: string): Promise<string[]> => {
  const dir = fileURLToPath(new URL(`../datasets/${sub}/`, import.meta.url));
  return (await readdir(dir)).filter((f) => f.endsWith('.jsonl')).map((f) => dir + f);
};
const retrievalFiles = await jsonlIn('retrieval');
const cases = await loadDataset(retrievalFiles);
const answerCases = await loadAnswerDataset(retrievalFiles, await jsonlIn('answer-only'));
const notInRulebook = answerCases.flatMap((a) => (a.kind === 'not-in-rulebook' ? [a.case] : []));
const chunks = await loadGameChunks(await loadEvalGames());
const issues = [...verifyDataset(cases, chunks), ...verifyAnswerOnly(notInRulebook, chunks)];
for (const i of issues) process.stdout.write(`${i.caseId}  ${i.itemKey}  ${i.problem}\n`);
process.stdout.write(
  `${cases.length} retrieval cases, ${notInRulebook.length} not-in-rulebook cases, ` +
    `${answerCases.length} answer cases, ${issues.length} issues\n`,
);
process.exit(issues.length === 0 ? 0 : 1);
