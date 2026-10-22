import * as cheerio from 'cheerio';
import { analyzeQuality } from '../quality.js';
import type { ParsedBlock, ParsedDocument } from '../types.js';
import type { DocumentParser } from './parser.js';

const STRIP_SELECTORS = [
  'script',
  'style',
  'noscript',
  'nav',
  'header',
  'footer',
  'aside',
  'form',
  'iframe',
  '.advertisement',
  '.ad',
  '.social',
  '.share',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
];

const MAIN_CANDIDATES = ['main', 'article', '[role="main"]', '#main', '#content', '.content'];

// Elements that start a new text block. Anything else (span, a, strong, …)
// is inline and stays within the surrounding block.
const BLOCK_TAGS = new Set([
  'p',
  'div',
  'section',
  'article',
  'main',
  'li',
  'ul',
  'ol',
  'dl',
  'dt',
  'dd',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'caption',
  'td',
  'th',
  'pre',
  'blockquote',
  'figure',
  'figcaption',
  'details',
  'summary',
  'hr',
]);

/** Minimal structural view of a domhandler node — enough for the walk. */
interface DomNode {
  type: string;
  name?: string;
  data?: string;
  children?: DomNode[];
}

/**
 * Web / living-rules parser (MASTER_PLAN §17). Strips scripts, nav, and
 * boilerplate; then walks the DOM in document order emitting headings and
 * text blocks (paragraphs, list items, table rows, definition terms, bare
 * div text) with the heading path stack that led to them.
 *
 * Web pages have no meaningful "page number", so we assign the virtual page
 * `1` to every block. Retrieval still surfaces the heading path.
 */
export function createHtmlParser(): DocumentParser {
  return {
    async parse(bytes: Uint8Array): Promise<ParsedDocument> {
      const html = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      const $ = cheerio.load(html);
      for (const sel of STRIP_SELECTORS) $(sel).remove();
      const $root = pickRoot($) ?? $('body');
      const blocks: ParsedBlock[] = [];
      const headingStack: { depth: number; text: string }[] = [];
      const currentPath = () => headingStack.map((h) => h.text);

      const emitParagraph = (text: string) => {
        const cleaned = collapseWhitespace(text);
        if (cleaned.length === 0) return;
        blocks.push({
          headingPath: currentPath(),
          pageStart: 1,
          pageEnd: 1,
          text: cleaned,
        });
      };

      // Walk in document order. Inline content accumulates into `pending`;
      // every block-level boundary flushes it, so each run of text is emitted
      // exactly once — no matter how lists, tables and divs nest.
      let pending = '';
      const flush = () => {
        emitParagraph(pending);
        pending = '';
      };
      const walk = (node: DomNode): void => {
        if (node.type === 'text') {
          pending += node.data ?? '';
          return;
        }
        if (node.type !== 'tag') return;
        const tag = node.name?.toLowerCase() ?? '';
        if (/^h[1-6]$/.test(tag)) {
          flush();
          const depth = Number(tag.slice(1));
          const cleaned = collapseWhitespace($(node as never).text());
          if (cleaned.length === 0) return;
          popTo(headingStack, depth - 1);
          headingStack.push({ depth, text: cleaned });
          blocks.push({
            headingPath: currentPath(),
            isHeading: true,
            headingDepth: depth,
            pageStart: 1,
            pageEnd: 1,
            text: cleaned,
          });
          return;
        }
        if (tag === 'br') {
          pending += ' ';
          return;
        }
        if (tag === 'tr') {
          const cells = (node.children ?? []).filter(
            (c) => c.type === 'tag' && (c.name === 'td' || c.name === 'th'),
          );
          // A data row (cells of inline text) becomes one block, keeping the
          // columns associated. A layout row — cells holding paragraphs or
          // headings — falls through to the structural walk below.
          if (!cells.some(hasBlockDescendant)) {
            flush();
            emitParagraph(
              cells
                .map((c) => collapseWhitespace($(c as never).text()))
                .filter((t) => t.length > 0)
                .join(' | '),
            );
            return;
          }
        }
        const isBlock = BLOCK_TAGS.has(tag);
        if (isBlock) flush();
        for (const child of node.children ?? []) walk(child);
        if (isBlock) flush();
      };
      for (const child of ($root.get(0) as DomNode | undefined)?.children ?? []) walk(child);
      flush();

      const combined = blocks.map((b) => b.text).join('\n');
      const quality = analyzeQuality({ pageCount: 1, pageTexts: [combined] });
      return { pageCount: 1, blocks, quality };
    },
  };
}

function pickRoot($: cheerio.CheerioAPI): cheerio.Cheerio<never> | null {
  for (const sel of MAIN_CANDIDATES) {
    const $node = $(sel).first();
    if ($node.length > 0) return $node as unknown as cheerio.Cheerio<never>;
  }
  return null;
}

function hasBlockDescendant(node: DomNode): boolean {
  return (node.children ?? []).some(
    (c) =>
      c.type === 'tag' &&
      (BLOCK_TAGS.has(c.name?.toLowerCase() ?? '') ||
        /^h[1-6]$/.test(c.name?.toLowerCase() ?? '') ||
        hasBlockDescendant(c)),
  );
}

function popTo(stack: { depth: number; text: string }[], depth: number): void {
  while (stack.length > 0 && stack[stack.length - 1]!.depth > depth) stack.pop();
}

function collapseWhitespace(input: string): string {
  return input.replace(/[\s\u00A0]+/g, ' ').trim();
}
