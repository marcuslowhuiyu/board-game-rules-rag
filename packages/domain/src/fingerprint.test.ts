import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { configurationFingerprint } from './fingerprint.js';
import { asContentId, asEditionId, asGameId } from './ids.js';

describe('configurationFingerprint', () => {
  it('is deterministic for the same inputs', () => {
    const g = asGameId('game1');
    const e = asEditionId('edition1');
    const c = [asContentId('c-a'), asContentId('c-b')];
    expect(configurationFingerprint(g, e, c)).toBe(configurationFingerprint(g, e, c));
  });

  it('is a 64-character hex string', () => {
    const g = asGameId('game1');
    const e = asEditionId('edition1');
    const c = [asContentId('c-a')];
    const fp = configurationFingerprint(g, e, c);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs when gameId differs', () => {
    const e = asEditionId('edition1');
    const c = [asContentId('c-a')];
    expect(configurationFingerprint(asGameId('a'), e, c)).not.toBe(
      configurationFingerprint(asGameId('b'), e, c),
    );
  });

  it('differs when editionId differs', () => {
    const g = asGameId('game1');
    const c = [asContentId('c-a')];
    expect(configurationFingerprint(g, asEditionId('e1'), c)).not.toBe(
      configurationFingerprint(g, asEditionId('e2'), c),
    );
  });

  it('deduplicates content ids', () => {
    const g = asGameId('game1');
    const e = asEditionId('edition1');
    expect(configurationFingerprint(g, e, [asContentId('c-a'), asContentId('c-a')])).toBe(
      configurationFingerprint(g, e, [asContentId('c-a')]),
    );
  });

  it('property: reordering enabledContentIds does not change fingerprint', () => {
    const idArb = fc.stringMatching(/^[a-z0-9-]{1,20}$/);
    fc.assert(
      fc.property(
        idArb,
        idArb,
        fc.uniqueArray(idArb, { minLength: 0, maxLength: 12 }),
        (game, edition, contents) => {
          const g = asGameId(game);
          const e = asEditionId(edition);
          const c = contents.map((x) => asContentId(x));
          const shuffled = [...c].reverse();
          expect(configurationFingerprint(g, e, c)).toBe(configurationFingerprint(g, e, shuffled));
        },
      ),
      { numRuns: 100 },
    );
  });
});
