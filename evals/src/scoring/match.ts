import type { RetrievedChunk } from '@bgr/retrieval';
import type { EvidenceItem } from '../dataset/case-schema.js';

/** Lowercase, straight quotes, single spaces. */
export function normalize(text: string): string {
  return text
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[‐‑‒–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Whitespace-free form used for matching. PDF extraction splits large display
 * fonts at arbitrary points ("L AUNCH A PROBE", "BET WEEN ROUNDS"), so word
 * boundaries in extracted text cannot be trusted; comparing without spaces
 * is immune to that and to line breaks inside a phrase.
 */
function compact(text: string): string {
  return normalize(text).replace(/\s+/g, '');
}

/** A chunk satisfies an item when it contains the phrase (and, if set, the heading). */
export function evidenceMatches(
  item: EvidenceItem,
  chunk: Pick<RetrievedChunk, 'text' | 'headingPath'>,
): boolean {
  if (!compact(chunk.text).includes(compact(item.phrase))) return false;
  if (item.heading === undefined) return true;
  const heading = compact(item.heading);
  return chunk.headingPath.some((h) => compact(h).includes(heading));
}
