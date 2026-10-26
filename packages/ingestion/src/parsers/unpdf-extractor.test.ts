import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { createUnpdfExtractor } from './unpdf-extractor.js';
import { createPdfTextLayerParser } from './pdf-parser.js';

async function buildTinyPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([600, 800]);
  page.drawText('COMBAT', { x: 40, y: 750, size: 24, font: boldFont, color: rgb(0, 0, 0) });
  page.drawText('2. Assign Hits', { x: 40, y: 700, size: 14, font: boldFont });
  page.drawText('The attacker assigns hits produced by their own units.', {
    x: 40,
    y: 670,
    size: 12,
    font,
  });
  const page2 = doc.addPage([600, 800]);
  page2.drawText('2.1 Sustain Damage', { x: 40, y: 750, size: 14, font: boldFont });
  page2.drawText('Sustain damage abilities may absorb the first hit.', {
    x: 40,
    y: 720,
    size: 12,
    font,
  });
  return doc.save();
}

describe('createUnpdfExtractor (real PDF integration)', () => {
  it('extracts per-page text from a synthetic pdf-lib PDF', async () => {
    const bytes = await buildTinyPdf();
    const extractor = createUnpdfExtractor();
    const { pages } = await extractor.extract(bytes);
    expect(pages).toHaveLength(2);
    // The exact text depends on pdfjs's spacing heuristic; assert on stable
    // fragments rather than an exact match.
    expect(pages[0]).toMatch(/COMBAT/);
    expect(pages[0]).toMatch(/Assign Hits/);
    expect(pages[0]).toMatch(/attacker assigns hits/i);
    expect(pages[1]).toMatch(/Sustain Damage/);
  });

  it('feeds into createPdfTextLayerParser end-to-end', async () => {
    const bytes = await buildTinyPdf();
    const parser = createPdfTextLayerParser(createUnpdfExtractor());
    const parsed = await parser.parse(bytes, { contentType: 'application/pdf' });
    expect(parsed.pageCount).toBe(2);
    expect(parsed.blocks.length).toBeGreaterThan(0);
    expect(parsed.quality.isLikelyScan).toBe(false);
    const headings = parsed.blocks.filter((b) => b.isHeading).map((b) => b.text);
    expect(headings.some((h) => /COMBAT/i.test(h))).toBe(true);
  }, 20_000);
});
