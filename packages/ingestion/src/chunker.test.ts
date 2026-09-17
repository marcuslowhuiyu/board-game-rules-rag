import { describe, expect, it } from 'vitest';
import { chunkDocument } from './chunker.js';
import type { ParsedBlock, ParsedDocument } from './types.js';

const parse = (blocks: ParsedBlock[]): ParsedDocument => ({
  pageCount: 1,
  blocks,
  quality: {
    emptyPageRatio: 0,
    averageCharsPerPage: 100,
    garbledCharRatio: 0,
    isLikelyScan: false,
    warnings: [],
  },
});

const heading = (text: string, depth = 1, page = 1): ParsedBlock => ({
  headingPath: [text],
  isHeading: true,
  headingDepth: depth,
  pageStart: page,
  pageEnd: page,
  text,
});

const para = (text: string, path: string[], page = 1): ParsedBlock => ({
  headingPath: path,
  pageStart: page,
  pageEnd: page,
  text,
});

describe('chunkDocument', () => {
  it('never merges across heading boundaries', () => {
    // Two headings, each with a short paragraph.
    const doc = parse([
      heading('Setup', 1, 1),
      para('Place the board.', ['Setup'], 1),
      heading('Combat', 1, 2),
      para('Roll dice.', ['Combat'], 2),
    ]);
    const chunks = chunkDocument(doc, { minTokens: 5, targetTokens: 50, maxTokens: 100 });
    expect(chunks.length).toBe(2);
    expect(chunks[0]!.headingPath).toEqual(['Setup']);
    expect(chunks[0]!.text).toMatch(/Setup/);
    expect(chunks[0]!.text).toMatch(/Place the board/);
    expect(chunks[1]!.headingPath).toEqual(['Combat']);
  });

  it('preserves page ranges as min/max of underlying blocks', () => {
    const doc = parse([
      heading('Section', 1, 3),
      para('First paragraph.', ['Section'], 3),
      para('Continues onto next page.', ['Section'], 4),
    ]);
    const chunks = chunkDocument(doc, { minTokens: 5, targetTokens: 50, maxTokens: 100 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.pageStart).toBe(3);
    expect(chunks[0]!.pageEnd).toBe(4);
  });

  it('splits oversized blocks at sentence boundaries', () => {
    // Sentences of ~40 chars each = ~10 tokens each.
    const big = Array.from(
      { length: 20 },
      (_, i) => `Rule number ${i} covers exactly this case.`,
    ).join(' ');
    const doc = parse([heading('Big', 1, 1), para(big, ['Big'], 1)]);
    const chunks = chunkDocument(doc, { minTokens: 30, targetTokens: 40, maxTokens: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.tokenCount).toBeLessThanOrEqual(50);
    }
    for (const c of chunks) {
      expect(c.headingPath).toEqual(['Big']);
      expect(c.pageStart).toBe(1);
      expect(c.pageEnd).toBe(1);
    }
  });

  it('assigns monotonically increasing ordinals', () => {
    const doc = parse([
      heading('A', 1, 1),
      para('One two three.', ['A'], 1),
      heading('B', 1, 2),
      para('Four five six.', ['B'], 2),
      heading('C', 1, 3),
      para('Seven eight nine.', ['C'], 3),
    ]);
    const chunks = chunkDocument(doc, { minTokens: 3, targetTokens: 10, maxTokens: 20 });
    expect(chunks.map((c) => c.ordinal)).toEqual(
      Array.from({ length: chunks.length }, (_, i) => i),
    );
  });

  it('emits an empty array when there are no blocks', () => {
    expect(chunkDocument(parse([]))).toEqual([]);
  });

  it('emits a short section as its own chunk', () => {
    // Section text below `minTokens` still gets a chunk (rule stays reachable
    // by its heading path).
    const doc = parse([heading('Tiny', 1, 1), para('One.', ['Tiny'], 1)]);
    const chunks = chunkDocument(doc, { minTokens: 100, targetTokens: 300, maxTokens: 500 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.headingPath).toEqual(['Tiny']);
  });
});
