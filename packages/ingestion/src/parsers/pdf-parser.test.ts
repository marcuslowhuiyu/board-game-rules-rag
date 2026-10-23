import { describe, expect, it } from 'vitest';
import { createPdfTextLayerParser } from './pdf-parser.js';

const extractor = {
  extract: async () => ({
    pages: [
      // Page 1
      `TWILIGHT IMPERIUM\n\nRules Reference\n\n1. INTRODUCTION\n\nThis document is the authoritative rules reference.\n\n2. SPACE COMBAT\n\nSpace combat occurs after movement.`,
      // Page 2
      `2.1 Assign Hits\n\nThe attacker assigns hits to their own units.\n\nEach unit takes one hit before another may be assigned.`,
    ],
  }),
};

describe('createPdfTextLayerParser', () => {
  it('emits headings and paragraphs with heading paths and page numbers', async () => {
    const parser = createPdfTextLayerParser(extractor);
    const doc = await parser.parse(new Uint8Array(), { contentType: 'application/pdf' });

    expect(doc.pageCount).toBe(2);
    const headings = doc.blocks.filter((b) => b.isHeading).map((b) => b.text);
    expect(headings).toEqual([
      'TWILIGHT IMPERIUM',
      '1. INTRODUCTION',
      '2. SPACE COMBAT',
      '2.1 Assign Hits',
    ]);

    const assignHits = doc.blocks.find(
      (b) => !b.isHeading && b.text.startsWith('The attacker assigns hits'),
    );
    expect(assignHits).toBeDefined();
    expect(assignHits!.headingPath).toEqual([
      'TWILIGHT IMPERIUM',
      '2. SPACE COMBAT',
      '2.1 Assign Hits',
    ]);
    expect(assignHits!.pageStart).toBe(2);
  });

  it('reports a scan-like quality when the extractor returns nothing', async () => {
    const emptyParser = createPdfTextLayerParser({ extract: async () => ({ pages: ['', ''] }) });
    const doc = await emptyParser.parse(new Uint8Array(), { contentType: 'application/pdf' });
    expect(doc.quality.isLikelyScan).toBe(true);
    expect(doc.blocks).toEqual([]);
  });

  it('surfaces extractor errors as a scan-like quality with a warning', async () => {
    const badParser = createPdfTextLayerParser({
      extract: async () => {
        throw new Error('boom');
      },
    });
    const doc = await badParser.parse(new Uint8Array(), { contentType: 'application/pdf' });
    expect(doc.quality.isLikelyScan).toBe(true);
    expect(doc.quality.warnings.some((w) => /PDF parse failed/.test(w))).toBe(true);
  });

  it('detects headings on any line when the extractor separates lines with single newlines', async () => {
    // unpdf joins a page's lines with "\n" and rarely emits blank lines, so a
    // whole page arrives as one paragraph.
    const parser = createPdfTextLayerParser({
      extract: async () => ({
        pages: [
          'COMBAT\nCombat resolves in rounds.\nMOVEMENT\nShips move up to their speed.\nPRODUCTION\nBuild units at a space dock.',
        ],
      }),
    });
    const doc = await parser.parse(new Uint8Array(), { contentType: 'application/pdf' });
    const body = (start: string) =>
      doc.blocks.find((b) => !b.isHeading && b.text.startsWith(start));
    expect(doc.blocks.filter((b) => b.isHeading).map((b) => b.text)).toEqual([
      'COMBAT',
      'MOVEMENT',
      'PRODUCTION',
    ]);
    expect(body('Combat resolves')?.headingPath).toEqual(['COMBAT']);
    expect(body('Ships move')?.headingPath).toEqual(['MOVEMENT']);
    expect(body('Build units')?.headingPath).toEqual(['PRODUCTION']);
  });

  it('does not treat quantity lines or numbered steps as headings (real SETI / Ticket to Ride lines)', async () => {
    const parser = createPdfTextLayerParser({
      extract: async () => ({
        pages: [
          [
            'GENERAL PIECES',
            '48 tech tiles',
            '30 Destination Ticket cards',
            '1 Longest Continuous Path',
            '2 data.',
            "1 energy to land if there's an orbiter at the",
            'ROTATING THE SOLAR SYSTEM',
            '1. The first time, rotate disc 1, the one on top.',
            '2. The second time, rotate disc 2. Disc 1 will naturally rotate with it.',
            '3. SCORING',
            'Score points at the end.',
            '3.1 Route Scoring Table',
            'Points depend on route length.',
          ].join('\n'),
        ],
      }),
    });
    const doc = await parser.parse(new Uint8Array(), { contentType: 'application/pdf' });
    expect(doc.blocks.filter((b) => b.isHeading).map((b) => b.text)).toEqual([
      'GENERAL PIECES',
      'ROTATING THE SOLAR SYSTEM',
      '3. SCORING',
      '3.1 Route Scoring Table',
    ]);
    const steps = doc.blocks.find((b) => !b.isHeading && b.text.startsWith('1. The first time'));
    expect(steps?.headingPath).toEqual(['ROTATING THE SOLAR SYSTEM']);
  });

  it('joins wrapped body lines under one heading into a single block', async () => {
    const parser = createPdfTextLayerParser({
      extract: async () => ({
        pages: ['COMBAT\nThe attacker assigns hits\nto their own units, one at a time.'],
      }),
    });
    const doc = await parser.parse(new Uint8Array(), { contentType: 'application/pdf' });
    const bodies = doc.blocks.filter((b) => !b.isHeading);
    expect(bodies.map((b) => b.text)).toEqual([
      'The attacker assigns hits to their own units, one at a time.',
    ]);
  });
});
