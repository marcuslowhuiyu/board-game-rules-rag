import { createHash } from 'node:crypto';
import type { ContentId, EditionId, GameId } from './ids.js';

/**
 * Deterministic fingerprint of a game configuration. Two sessions with the
 * same (gameId, editionId, set of enabledContentIds) yield the same
 * fingerprint regardless of the array order the caller happened to use.
 *
 * Implemented as SHA-256 over a canonical text form. Not a cryptographic
 * commitment — just a stable identifier used for cache keying and equality
 * checks (M6 ruling cache reads this).
 */
export function configurationFingerprint(
  gameId: GameId,
  editionId: EditionId,
  enabledContentIds: readonly ContentId[],
): string {
  const uniqueSorted = Array.from(new Set(enabledContentIds)).sort();
  const canonical = JSON.stringify({
    g: gameId,
    e: editionId,
    c: uniqueSorted,
  });
  return createHash('sha256').update(canonical).digest('hex');
}
