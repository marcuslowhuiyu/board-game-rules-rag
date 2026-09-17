import { describe, expect, it } from 'vitest';
import { createHtmlParser } from './html-parser.js';

const encode = (s: string) => new TextEncoder().encode(s);

describe('createHtmlParser', () => {
  it('extracts headings and paragraphs with a heading path', async () => {
    const parser = createHtmlParser();
    const html = `<!doctype html><html><body>
      <main>
        <h1>Combat</h1>
        <p>Combat resolves in rounds.</p>
        <h2>Assign Hits</h2>
        <p>The attacker assigns hits.</p>
      </main>
    </body></html>`;
    const doc = await parser.parse(encode(html), { contentType: 'text/html' });
    const paths = doc.blocks.map((b) => ({ h: b.isHeading, path: b.headingPath, t: b.text }));
    expect(paths).toEqual([
      { h: true, path: ['Combat'], t: 'Combat' },
      { h: undefined, path: ['Combat'], t: 'Combat resolves in rounds.' },
      { h: true, path: ['Combat', 'Assign Hits'], t: 'Assign Hits' },
      { h: undefined, path: ['Combat', 'Assign Hits'], t: 'The attacker assigns hits.' },
    ]);
  });

  it('strips scripts, styles, nav', async () => {
    const parser = createHtmlParser();
    const html = `<html><body>
      <nav>Skip me</nav>
      <script>alert(1)</script>
      <style>body{color:red}</style>
      <main><p>Rule text.</p></main>
    </body></html>`;
    const doc = await parser.parse(encode(html), { contentType: 'text/html' });
    const texts = doc.blocks.map((b) => b.text);
    expect(texts.some((t) => t.includes('Skip me'))).toBe(false);
    expect(texts.some((t) => t.includes('alert'))).toBe(false);
    expect(texts.some((t) => t.includes('Rule text.'))).toBe(true);
  });

  it('falls back to body when no <main>', async () => {
    const parser = createHtmlParser();
    const html = `<html><body><h1>Root</h1><p>Body only.</p></body></html>`;
    const doc = await parser.parse(encode(html), { contentType: 'text/html' });
    expect(doc.blocks.some((b) => b.text === 'Body only.')).toBe(true);
  });
});
