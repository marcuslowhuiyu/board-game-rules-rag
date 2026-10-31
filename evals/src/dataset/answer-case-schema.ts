import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { z } from 'zod';
import {
  AnswerExpectationSchema,
  DatasetError,
  loadDataset,
  RetrievalCaseSchema,
  type AnswerExpectation,
  type RetrievalCase,
} from './case-schema.js';

export { AnswerExpectationSchema, type AnswerExpectation };

/**
 * A question whose answer is truly absent from every enabled source. It has
 * no required evidence: the only correct outcome is INCONCLUSIVE.
 */
export const AnswerOnlyCaseSchema = z.object({
  id: RetrievalCaseSchema.shape.id,
  game: RetrievalCaseSchema.shape.game,
  edition: RetrievalCaseSchema.shape.edition,
  enabledContent: RetrievalCaseSchema.shape.enabledContent,
  tier: RetrievalCaseSchema.shape.tier,
  question: RetrievalCaseSchema.shape.question,
  source: RetrievalCaseSchema.shape.source,
  notes: RetrievalCaseSchema.shape.notes,
  answer: AnswerExpectationSchema.refine((a) => a.certainty === 'INCONCLUSIVE', {
    message: 'a not-in-rulebook case must expect INCONCLUSIVE',
    path: ['certainty'],
  }),
});
export type AnswerOnlyCase = z.infer<typeof AnswerOnlyCaseSchema>;

export type AnswerCase =
  | { kind: 'answerable'; case: RetrievalCase & { answer: AnswerExpectation } }
  | { kind: 'not-in-rulebook'; case: AnswerOnlyCase };

async function loadAnswerOnly(path: string): Promise<AnswerOnlyCase[]> {
  const cases: AnswerOnlyCase[] = [];
  const lines = (await readFile(path, 'utf8')).split('\n');
  for (const [i, line] of lines.entries()) {
    if (line.trim().length === 0) continue;
    const where = `${basename(path)}:${i + 1}`;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (err) {
      throw new DatasetError(`${where}: invalid JSON (${(err as Error).message})`);
    }
    const parsed = AnswerOnlyCaseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new DatasetError(`${where}: ${z.prettifyError(parsed.error)}`);
    }
    cases.push(parsed.data);
  }
  return cases;
}

/**
 * Answer cases: retrieval cases that carry an `answer` block, then the
 * answer-only cases. Ids must be unique across both sets, and a question may
 * appear once per game (a later task maps question text to its labelled tier).
 */
export async function loadAnswerDataset(
  retrievalPaths: readonly string[],
  answerOnlyPaths: readonly string[],
): Promise<AnswerCase[]> {
  const out: AnswerCase[] = [];
  for (const c of await loadDataset(retrievalPaths)) {
    if (c.answer) out.push({ kind: 'answerable', case: { ...c, answer: c.answer } });
  }
  for (const path of answerOnlyPaths) {
    for (const c of await loadAnswerOnly(path)) out.push({ kind: 'not-in-rulebook', case: c });
  }
  const ids = new Set<string>();
  const questions = new Set<string>();
  for (const { case: c } of out) {
    if (ids.has(c.id)) throw new DatasetError(`duplicate case id ${c.id}`);
    ids.add(c.id);
    const qKey = `${c.game}\u0000${c.question}`;
    if (questions.has(qKey)) {
      throw new DatasetError(`duplicate question in game ${c.game}: ${c.question} (${c.id})`);
    }
    questions.add(qKey);
  }
  return out;
}
