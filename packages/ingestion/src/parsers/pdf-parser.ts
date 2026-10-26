import { analyzeQuality } from '../quality.js';
import type { ParsedBlock, ParsedDocument } from '../types.js';
import type { DocumentParser } from './parser.js';

export interface PdfExtractor {
  /** Extract per-page plaintext from a PDF buffer. */
  extract(bytes: Uint8Array): Promise<{ pages: string[] }>;
}

export interface PdfParserOptions {
  /**
   * Detects headings from a line of plaintext. Defaults to a lightweight
   * heuristic (ALL-CAPS + short numeric prefix). Override for test fixtures.
   */
  isHeading?: (line: string) => { depth: number } | null;
}

const DEFAULT_HEADING = (line: string): { depth: number } | null => {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.length > 100) return null;
  // Numeric hierarchical headings: "1. Combat", "1.2 Assign Hits", "1.2.3 …".
  // Depth = 1 + numberOfDottedParts, so `1.` sits under an all-caps title
  // heading (depth 1), `1.1` nests under `1.`, and so on.
  //
  // Real rulebooks are full of lines that merely start with a number —
  // component quantities ("48 tech tiles"), mid-sentence wraps ("2 data.")
  // and numbered steps ("1. The first time, rotate …"). So a numeric heading
  // needs a section-style number ("1." or "2.1", never a bare "1"), a short
  // title that starts with a capital, and no sentence punctuation at the end.
  const numeric = /^(\d+(?:\.\d+){0,3})(\.?)\s+(\S.*)$/.exec(trimmed);
  if (numeric) {
    const [, number, trailingDot, title] = numeric as unknown as [string, string, string, string];
    const parts = number.split('.').length;
    const sectionStyle = parts > 1 || trailingDot === '.';
    const titleLike =
      /^[A-Z]/.test(title) && !/[.,;:!?]$/.test(title) && title.split(/\s+/).length <= 8;
    return sectionStyle && titleLike ? { depth: Math.min(parts + 1, 6) } : null;
  }
  // ALL-CAPS heading lines (`SPACE COMBAT`, `ASSIGN HITS`). Depth 1.
  if (/^[A-Z0-9][A-Z0-9 ,.'\-:&/]{2,}$/.test(trimmed) && /[A-Z]/.test(trimmed)) {
    if (trimmed.split(/\s+/).length > 8) return null;
    return { depth: 1 };
  }
  return null;
};

/**
 * Deterministic PDF text-layer parser (MASTER_PLAN §16 first-choice). Turns
 * per-page plaintext into `ParsedBlock`s, tagging heading lines with
 * `isHeading`. The chunker (`chunker.ts`) then does heading-aware grouping.
 */
export function createPdfTextLayerParser(
  extractor: PdfExtractor,
  options: PdfParserOptions = {},
): DocumentParser {
  const isHeading = options.isHeading ?? DEFAULT_HEADING;
  return {
    async parse(bytes: Uint8Array): Promise<ParsedDocument> {
      let extracted: { pages: string[] };
      try {
        extracted = await extractor.extract(bytes);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          pageCount: 0,
          blocks: [],
          quality: {
            emptyPageRatio: 1,
            averageCharsPerPage: 0,
            garbledCharRatio: 0,
            isLikelyScan: true,
            warnings: [`PDF parse failed: ${message}`],
          },
        };
      }
      const pages = extracted.pages.map(normalizePageText);
      const quality = analyzeQuality({ pageCount: pages.length, pageTexts: pages });
      const blocks = buildBlocks(pages, isHeading);
      return { pageCount: pages.length, blocks, quality };
    },
  };
}

function normalizePageText(page: string): string {
  return page
    .replace(/\r\n?/g, '\n')
    .replace(/[\u00AD\u200B\uFEFF]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildBlocks(
  pages: string[],
  isHeading: (line: string) => { depth: number } | null,
): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  const headingStack: { depth: number; text: string }[] = [];

  const currentPath = (): string[] => headingStack.map((h) => h.text);

  for (let i = 0; i < pages.length; i++) {
    const pageNumber = i + 1;
    const raw = pages[i]!;
    if (raw.length === 0) continue;
    // Paragraph split on blank lines.
    const paragraphs = raw.split(/\n{2,}/);
    for (const para of paragraphs) {
      const lines = para
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      if (lines.length === 0) continue;
      // Every line can be a heading: real extractors (unpdf) separate lines
      // with single newlines, so one "paragraph" often spans several
      // sections. Body lines accumulate until the next heading flushes them.
      let body: string[] = [];
      const flushBody = () => {
        if (body.length === 0) return;
        blocks.push({
          headingPath: currentPath(),
          pageStart: pageNumber,
          pageEnd: pageNumber,
          text: body.join(' '),
        });
        body = [];
      };
      for (const line of lines) {
        const heading = isHeading(line);
        if (!heading) {
          body.push(line);
          continue;
        }
        flushBody();
        popTo(headingStack, heading.depth - 1);
        headingStack.push({ depth: heading.depth, text: line });
        blocks.push({
          headingPath: currentPath(),
          isHeading: true,
          headingDepth: heading.depth,
          pageStart: pageNumber,
          pageEnd: pageNumber,
          text: line,
        });
      }
      flushBody();
    }
  }
  return blocks;
}

function popTo(stack: { depth: number; text: string }[], depth: number): void {
  while (stack.length > 0 && stack[stack.length - 1]!.depth > depth) stack.pop();
}
