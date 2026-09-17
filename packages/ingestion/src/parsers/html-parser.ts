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

/**
 * Web / living-rules parser (MASTER_PLAN §17). Strips scripts, nav, and
 * boilerplate; then walks the DOM in document order emitting headings and
 * paragraph blocks with the heading path stack that led to them.
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

      $root.find('h1, h2, h3, h4, h5, h6, p, li').each((_, el) => {
        const $el = $(el);
        const tag = (el as { tagName?: string }).tagName?.toLowerCase() ?? '';
        const text = $el.text();
        if (!text) return;
        if (/^h[1-6]$/.test(tag)) {
          const depth = Number(tag.slice(1));
          const cleaned = collapseWhitespace(text);
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
        emitParagraph(text);
      });

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

function popTo(stack: { depth: number; text: string }[], depth: number): void {
  while (stack.length > 0 && stack[stack.length - 1]!.depth > depth) stack.pop();
}

function collapseWhitespace(input: string): string {
  return input.replace(/[\s\u00A0]+/g, ' ').trim();
}
