import { describe, expect, it } from 'vitest';
import { isTestFixtureGame } from './game-visibility.js';

describe('isTestFixtureGame', () => {
  it.each([
    'acceptance-test-supersede',
    'provenance-smoke-test',
    'seti-eval',
    'ticket-to-ride-eval',
    'wingspan-eval',
  ])('hides fixture %s', (slug) => {
    expect(isTestFixtureGame({ slug })).toBe(true);
  });

  it.each([
    'seti-search-for-extraterrestrial-intelligence',
    'ticket-to-ride',
    'twilight-imperium-4',
    'wingspan',
    'medieval-academy',
  ])('keeps real game %s', (slug) => {
    expect(isTestFixtureGame({ slug })).toBe(false);
  });
});
