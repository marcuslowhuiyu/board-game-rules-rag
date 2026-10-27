import { describe, expect, it } from 'vitest';
import { evidenceMatches, normalize } from './match.js';

describe('normalize', () => {
  it('lowercases, straightens quotes and collapses whitespace', () => {
    expect(normalize('Don’t  forget\nto ROTATE')).toBe("don't forget to rotate");
  });

  it('leaves ordinary capitalised words alone', () => {
    expect(normalize('Pay 2 credits to launch a probe')).toBe('pay 2 credits to launch a probe');
  });
});

describe('evidenceMatches', () => {
  it('matches letter-spaced headings from large PDF fonts', () => {
    const at = (text: string) => ({ text, headingPath: [] });
    expect(
      evidenceMatches(
        { key: 'k', phrase: 'launch a probe', required: true },
        at('L AUNCH A PROBE'),
      ),
    ).toBe(true);
    expect(
      evidenceMatches(
        { key: 'k', phrase: 'between rounds', required: true },
        at('BET WEEN ROUNDS'),
      ),
    ).toBe(true);
  });

  it('matches a heading that is letter-spaced in the heading path', () => {
    const item = { key: 'k', phrase: 'pay 2 credits', heading: 'Launch a probe', required: true };
    expect(evidenceMatches(item, { text: 'Pay 2 credits', headingPath: ['L AUNCH A PROBE'] })).toBe(
      true,
    );
  });

  const chunk = {
    text: 'When you finish your main action,\nresolve all of the sectors that have been completed.',
    headingPath: ['SECTORS', 'Completing a Sector'],
  };

  it('matches a phrase across a line break', () => {
    const item = { key: 'k', phrase: 'main action, resolve all of the sectors', required: true };
    expect(evidenceMatches(item, chunk)).toBe(true);
  });

  it('fails when the heading is set but absent from the heading path', () => {
    const item = {
      key: 'k',
      phrase: 'resolve all of the sectors',
      heading: 'Milestones',
      required: true,
    };
    expect(evidenceMatches(item, chunk)).toBe(false);
  });

  it('matches when the heading is part of a heading path entry', () => {
    const item = {
      key: 'k',
      phrase: 'resolve all of the sectors',
      heading: 'completing a sector',
      required: true,
    };
    expect(evidenceMatches(item, chunk)).toBe(true);
  });

  it('passes on the phrase alone when no heading is set', () => {
    const item = { key: 'k', phrase: 'RESOLVE ALL of the sectors', required: true };
    expect(evidenceMatches(item, chunk)).toBe(true);
  });

  it('does not match a phrase whose word boundary falls inside a word', () => {
    const item = { key: 'k', phrase: 'the card is now here', required: true };
    expect(
      evidenceMatches(item, { text: 'The card is nowhere to be seen.', headingPath: [] }),
    ).toBe(false);
  });
});
