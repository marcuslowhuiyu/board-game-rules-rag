import type { PdfExtractor } from './pdf-parser.js';

/**
 * Real PDF text-layer extractor backed by `unpdf` (a Node/serverless-friendly
 * wrapper around pdfjs-dist). Kept in its own module so the base parser can
 * be unit-tested without importing pdfjs.
 */
export function createUnpdfExtractor(): PdfExtractor {
  return {
    async extract(bytes: Uint8Array): Promise<{ pages: string[] }> {
      const { extractText, getDocumentProxy } = await import('unpdf');
      const doc = await getDocumentProxy(bytes);
      const { text } = await extractText(doc, { mergePages: false });
      const pages = Array.isArray(text) ? text : [text ?? ''];
      return { pages: pages.map((p) => p ?? '') };
    },
  };
}
