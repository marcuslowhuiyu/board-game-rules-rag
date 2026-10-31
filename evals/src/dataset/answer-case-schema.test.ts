import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AnswerOnlyCaseSchema, loadAnswerDataset } from './answer-case-schema.js';
import { DatasetError, RetrievalCaseSchema } from './case-schema.js';

const retrieval = {
  id: 'seti-sector-timing',
  game: 'seti',
  edition: 'base',
  enabledContent: ['base'],
  tier: 'simple',
  question: 'When is a completed sector resolved?',
  requiredEvidence: [
    { key: 'seti/sectors/resolve', phrase: 'resolve all of the sectors', required: true },
  ],
  source: { url: 'https://boardgamegeek.com/thread/3459324', title: 'When to resolve' },
};

const answerOnly = {
  id: 'seti-online-play',
  game: 'seti',
  edition: 'base',
  enabledContent: ['base'],
  tier: 'simple',
  question: 'Can I play this online with friends?',
  source: { url: 'https://boardgamegeek.com/thread/1', title: 'Online play' },
  answer: { certainty: 'INCONCLUSIVE' },
};

function writeTmp(name: string, rows: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'bgr-answer-'));
  const path = join(dir, name);
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n'));
  return path;
}

describe('answer expectations', () => {
  it('retrieval case without answer block still loads', () => {
    expect(RetrievalCaseSchema.safeParse(retrieval).success).toBe(true);
  });

  it('answer-only case must expect INCONCLUSIVE', () => {
    const bad = { ...answerOnly, answer: { certainty: 'DEFINITIVE' } };
    expect(AnswerOnlyCaseSchema.safeParse(bad).success).toBe(false);
    expect(AnswerOnlyCaseSchema.safeParse(answerOnly).success).toBe(true);
  });

  it('answerable case cannot expect INCONCLUSIVE', () => {
    const bad = { ...retrieval, answer: { certainty: 'INCONCLUSIVE' } };
    expect(RetrievalCaseSchema.safeParse(bad).success).toBe(false);
    const ok = { ...retrieval, answer: { certainty: 'DEFINITIVE', authority: 'OFFICIAL_RULES' } };
    expect(RetrievalCaseSchema.safeParse(ok).success).toBe(true);
  });

  it('forbidden claim over 15 words is rejected', () => {
    const long = Array.from({ length: 16 }, (_, i) => `w${i}`).join(' ');
    const bad = { ...retrieval, answer: { certainty: 'DEFINITIVE', forbiddenClaims: [long] } };
    expect(RetrievalCaseSchema.safeParse(bad).success).toBe(false);
  });
});

describe('loadAnswerDataset', () => {
  it('skips retrieval cases without answer and rejects duplicate ids across sets', async () => {
    const withAnswer = {
      ...retrieval,
      id: 'seti-with-answer',
      question: 'Another question?',
      answer: { certainty: 'DEFINITIVE' },
    };
    const r = writeTmp('r.jsonl', [retrieval, withAnswer]);
    const a = writeTmp('a.jsonl', [answerOnly]);
    const loaded = await loadAnswerDataset([r], [a]);
    expect(loaded.map((c) => [c.kind, c.case.id])).toEqual([
      ['answerable', 'seti-with-answer'],
      ['not-in-rulebook', 'seti-online-play'],
    ]);

    const dup = writeTmp('d.jsonl', [{ ...answerOnly, id: 'seti-with-answer' }]);
    await expect(loadAnswerDataset([r], [dup])).rejects.toBeInstanceOf(DatasetError);
  });

  it('rejects the same question twice within a game', async () => {
    const withAnswer = { ...retrieval, id: 'seti-q-a', answer: { certainty: 'DEFINITIVE' } };
    const r = writeTmp('r.jsonl', [withAnswer]);
    const a = writeTmp('a.jsonl', [{ ...answerOnly, question: retrieval.question }]);
    await expect(loadAnswerDataset([r], [a])).rejects.toThrow(/duplicate question/);
    // The same text in a different game is fine.
    const other = writeTmp('o.jsonl', [
      { ...answerOnly, game: 'wingspan', question: retrieval.question },
    ]);
    await expect(loadAnswerDataset([r], [other])).resolves.toHaveLength(2);
  });

  it('reports a bad answer-only line with its file and line', async () => {
    const a = writeTmp('bad.jsonl', [{ ...answerOnly, answer: { certainty: 'DEFINITIVE' } }]);
    await expect(loadAnswerDataset([], [a])).rejects.toThrow(/bad\.jsonl:1/);
  });

  it('loads the committed dataset: 75-100 cases with not-in-rulebook cases for every game', async () => {
    const jsonl = (sub: string) => {
      const dir = fileURLToPath(new URL(`../../datasets/${sub}/`, import.meta.url));
      return readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => join(dir, f));
    };
    const cases = await loadAnswerDataset(jsonl('retrieval'), jsonl('answer-only'));
    expect(cases.length).toBeGreaterThanOrEqual(75);
    expect(cases.length).toBeLessThanOrEqual(100);
    const games = (kind: string) =>
      new Set(cases.filter((c) => c.kind === kind).map((c) => c.case.game));
    expect(games('not-in-rulebook')).toEqual(games('answerable'));
  });
});
