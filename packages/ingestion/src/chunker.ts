import { approxTokenCount } from './tokens.js';
import type { ChunkOutput, ParsedBlock, ParsedDocument } from './types.js';

export interface ChunkerOptions {
  /** Minimum chunk size in approximate tokens. Default 300. */
  minTokens?: number;
  /** Target chunk size in approximate tokens. Default 500. */
  targetTokens?: number;
  /** Hard cap in approximate tokens; a block that exceeds this on its own is
   *  split at sentence boundaries. Default 700. */
  maxTokens?: number;
}

const DEFAULTS = { minTokens: 300, targetTokens: 500, maxTokens: 700 } as const;

/**
 * Heading-aware chunker (MASTER_PLAN §15).
 *
 * Rules of the room:
 *  - Never merge body text across a heading boundary. If a section is
 *    shorter than `minTokens` we still emit it, so a rule that lives under
 *    its own heading stays retrievable by that heading path.
 *  - Headings with no body before the next heading are folded into the next
 *    section (path = the latest heading's) instead of becoming heading-only
 *    chunks; only a body-less heading at the very end is emitted alone.
 *  - A block whose text itself exceeds `maxTokens` is split at sentence
 *    boundaries; the split fragments keep the same heading path and page
 *    range.
 *  - Within a section, adjacent blocks are merged greedily until
 *    `targetTokens` is reached, then closed. This yields chunks near the
 *    target and keeps a rule together with its immediate follow-up sentences.
 *  - `pageStart` / `pageEnd` are the min/max of the source blocks.
 */
export function chunkDocument(parsed: ParsedDocument, options: ChunkerOptions = {}): ChunkOutput[] {
  const min = options.minTokens ?? DEFAULTS.minTokens;
  const target = options.targetTokens ?? DEFAULTS.targetTokens;
  const max = options.maxTokens ?? DEFAULTS.maxTokens;
  if (min > target || target > max) {
    throw new Error(`invalid chunker sizes: min(${min}) <= target(${target}) <= max(${max})`);
  }

  const out: ChunkOutput[] = [];
  let bucket: ParsedBlock[] = [];
  let bucketTokens = 0;
  let bucketHeadingPath: string[] = [];

  const flush = () => {
    if (bucket.length === 0) return;
    const text = joinBlocks(bucket);
    const pageStart = Math.min(...bucket.map((b) => b.pageStart));
    const pageEnd = Math.max(...bucket.map((b) => b.pageEnd));
    out.push({
      ordinal: out.length,
      headingPath: bucketHeadingPath.slice(),
      pageStart,
      pageEnd,
      text,
      charCount: text.length,
      tokenCount: approxTokenCount(text),
    });
    bucket = [];
    bucketTokens = 0;
  };

  for (const block of parsed.blocks) {
    if (block.text.trim().length === 0 && !block.isHeading) continue;

    // Heading boundaries close the current bucket. The heading text itself
    // becomes the start of a new bucket so downstream retrieval can still
    // see the heading in the chunk body.
    if (block.isHeading) {
      const headingTokens = approxTokenCount(block.text);
      if (
        bucket.length > 0 &&
        bucket.every((b) => b.isHeading) &&
        // Measure the joined text, separators included — that is what the
        // emitted chunk's tokenCount is computed from.
        approxTokenCount(joinBlocks([...bucket, block])) <= max
      ) {
        // Body-less headings so far (a parent straight into its child, or a
        // diagram's labels): fold them into this section rather than emit
        // heading-only chunks. The deepest/latest heading's path wins.
        bucket.push(block);
        bucketTokens += headingTokens;
      } else {
        flush();
        bucket = [block];
        bucketTokens = headingTokens;
      }
      bucketHeadingPath = block.headingPath.slice();
      continue;
    }

    // Path change without an explicit heading — treat as a section break.
    if (!samePath(block.headingPath, bucketHeadingPath) && bucket.length > 0) {
      flush();
      bucketHeadingPath = block.headingPath.slice();
    }
    if (bucket.length === 0) {
      bucketHeadingPath = block.headingPath.slice();
    }

    const blockTokens = approxTokenCount(block.text);
    if (blockTokens > max) {
      // Big block on its own — flush what we have, then split the giant.
      flush();
      const fragments = splitOversizedBlock(block, max);
      for (const frag of fragments) {
        bucket = [frag];
        bucketTokens = approxTokenCount(frag.text);
        flush();
      }
      continue;
    }

    if (bucketTokens + blockTokens > max) {
      flush();
      bucketHeadingPath = block.headingPath.slice();
    }
    bucket.push(block);
    bucketTokens += blockTokens;
    if (bucketTokens >= target) flush();
  }
  flush();
  return out;
}

function samePath(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function joinBlocks(blocks: ParsedBlock[]): string {
  return blocks
    .map((b) => b.text)
    .join('\n\n')
    .trim();
}

/**
 * Split a giant block into `<= max` token chunks along sentence boundaries.
 * If a single sentence is still oversized (rare — usually a table dumped as
 * one line), fall back to a hard split on the character budget.
 */
function splitOversizedBlock(block: ParsedBlock, max: number): ParsedBlock[] {
  const sentences = block.text.split(/(?<=[.!?])\s+(?=[A-Z(])/g).filter((s) => s.trim().length > 0);
  const out: ParsedBlock[] = [];
  let buf: string[] = [];
  const flush = () => {
    if (buf.length === 0) return;
    out.push({ ...block, text: buf.join(' ') });
    buf = [];
  };
  const projectedTokens = (extra: string) => approxTokenCount([...buf, extra].join(' '));
  for (const s of sentences) {
    if (approxTokenCount(s) > max) {
      flush();
      const size = max * 4;
      for (let i = 0; i < s.length; i += size) {
        out.push({ ...block, text: s.slice(i, i + size) });
      }
      continue;
    }
    if (buf.length > 0 && projectedTokens(s) > max) flush();
    buf.push(s);
  }
  flush();
  return out;
}
