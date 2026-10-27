import { describe, expect, it } from 'vitest';
import type { RetrievalCase } from './case-schema.js';
import { verifyDataset } from './verify.js';

const make = (phrase: string, heading?: string): RetrievalCase => ({
  id: 'c1',
  game: 'seti',
  edition: 'base',
  enabledContent: ['base'],
  tier: 'simple',
  question: 'q',
  requiredEvidence: [{ key: 'k', phrase, required: true, ...(heading ? { heading } : {}) }],
  source: { url: 'https://example.com/t', title: 't' },
});

const chunks = {
  seti: [
    { text: 'When you finish your main action, resolve all of', headingPath: ['SECTORS'] },
    { text: 'the sectors that have been completed.', headingPath: ['SECTORS'] },
    { text: 'Rotate the solar system before choosing your tech.', headingPath: ['R ESEARCH'] },
  ],
  wingspan: [{ text: 'Rotate the solar system before choosing your tech.', headingPath: [] }],
};

describe('verifyDataset', () => {
  it('flags a phrase found in no chunk', () => {
    expect(verifyDataset([make('launch a probe')], chunks)).toEqual([
      { caseId: 'c1', itemKey: 'k', problem: 'phrase-not-found' },
    ]);
  });

  it('flags a phrase split across two chunks', () => {
    const issues = verifyDataset([make('resolve all of the sectors')], chunks);
    expect(issues.map((i) => i.problem)).toEqual(['phrase-not-found']);
  });

  it('flags a heading that does not match the chunk holding the phrase', () => {
    const issues = verifyDataset([make('main action', 'Milestones')], chunks);
    expect(issues.map((i) => i.problem)).toEqual(['heading-mismatch']);
  });

  it('passes a phrase present in one chunk with matching heading', () => {
    expect(verifyDataset([make('main action', 'Sectors')], chunks)).toEqual([]);
    expect(
      verifyDataset([make('choosing your tech', 'Research')], chunks).map((i) => i.problem),
    ).toEqual(['phrase-in-multiple-games']);
  });

  it('flags a case whose game has no chunks loaded', () => {
    const c = { ...make('main action'), game: 'ghost' };
    expect(verifyDataset([c], chunks).map((i) => i.problem)).toEqual(['phrase-not-found']);
  });
});
