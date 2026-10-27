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

const escape = (ch: string) => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Pattern for a phrase in extracted text. PDF extraction splits large display
 * fonts inside words ("L AUNCH A PROBE", "BET WEEN ROUNDS"), so a single stray
 * space may appear between any two letters; but a space in the phrase must be
 * a space in the text, so "now here" never matches "nowhere".
 */
function phrasePattern(phrase: string): RegExp {
  const chars = [...normalize(phrase)];
  const source = chars
    .map((ch, i) => {
      if (ch === ' ') return '\\s+';
      const next = chars[i + 1];
      return escape(ch) + (next !== undefined && next !== ' ' ? ' ?' : '');
    })
    .join('');
  return new RegExp(source);
}

/** A chunk satisfies an item when it contains the phrase (and, if set, the heading). */
export function evidenceMatches(
  item: EvidenceItem,
  chunk: Pick<RetrievedChunk, 'text' | 'headingPath'>,
): boolean {
  if (!phrasePattern(item.phrase).test(normalize(chunk.text))) return false;
  if (item.heading === undefined) return true;
  const heading = phrasePattern(item.heading);
  return chunk.headingPath.some((h) => heading.test(normalize(h)));
}
