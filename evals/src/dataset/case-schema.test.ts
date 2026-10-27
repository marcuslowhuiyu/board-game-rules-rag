import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DatasetError, loadDataset, RetrievalCaseSchema } from './case-schema.js';

const item = (key: string, required = true) => ({
  key,
  phrase: 'resolve all of the sectors',
  required,
});

const baseCase = {
  id: 'seti-sector-timing',
  game: 'seti',
  edition: 'base',
  enabledContent: ['base'],
  tier: 'simple',
  question: 'When is a completed sector resolved?',
  requiredEvidence: [item('seti/sectors/resolve')],
  source: { url: 'https://boardgamegeek.com/thread/3459324', title: 'When to resolve' },
};

function writeTmp(name: string, lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'bgr-evals-'));
  const path = join(dir, name);
  writeFileSync(path, lines.join('\n'));
  return path;
}

describe('RetrievalCaseSchema', () => {
  it('accepts a simple case with one required item', () => {
    expect(RetrievalCaseSchema.safeParse(baseCase).success).toBe(true);
  });

  it('accepts supporting items alongside the one required item of a simple case', () => {
    const c = { ...baseCase, requiredEvidence: [item('a'), item('b', false)] };
    expect(RetrievalCaseSchema.safeParse(c).success).toBe(true);
  });

  it('rejects a simple case with two required items', () => {
    const r = RetrievalCaseSchema.safeParse({
      ...baseCase,
      requiredEvidence: [item('a'), item('b')],
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toMatch(/simple.*exactly one required/);
  });

  it('rejects a complex case with one required item', () => {
    const r = RetrievalCaseSchema.safeParse({
      ...baseCase,
      tier: 'complex',
      requiredEvidence: [item('a'), item('b', false)],
    });
    expect(r.success).toBe(false);
  });

  it('rejects a phrase over 15 words', () => {
    const long = Array.from({ length: 16 }, (_, i) => `w${i}`).join(' ');
    const r = RetrievalCaseSchema.safeParse({
      ...baseCase,
      requiredEvidence: [{ ...item('a'), phrase: long }],
    });
    expect(r.success).toBe(false);
  });
});

describe('loadDataset', () => {
  it('reports file and line of a malformed line', async () => {
    const path = writeTmp('bad.jsonl', [JSON.stringify(baseCase), '{"id": "x"}']);
    await expect(loadDataset([path])).rejects.toThrow(/bad\.jsonl:2/);
    await expect(loadDataset([path])).rejects.toBeInstanceOf(DatasetError);
  });

  it('skips blank lines and loads every case', async () => {
    const path = writeTmp('ok.jsonl', [JSON.stringify(baseCase), '']);
    expect(await loadDataset([path])).toHaveLength(1);
  });

  it('rejects duplicate ids across files', async () => {
    const a = writeTmp('a.jsonl', [JSON.stringify(baseCase)]);
    const b = writeTmp('b.jsonl', [JSON.stringify(baseCase)]);
    await expect(loadDataset([a, b])).rejects.toThrow(/duplicate case id seti-sector-timing/);
  });
});
