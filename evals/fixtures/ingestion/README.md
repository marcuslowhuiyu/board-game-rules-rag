# Ingestion fixtures

Small, hand-crafted rulebook and living-rules fixtures used by M2 acceptance
tests and by the dev deployment smoke test. Deliberately synthetic — no
third-party rulebook content lives here.

## Files

- `tiny-rulebook.pages.json` — per-page plaintext for a two-page rulebook.
  Feed it to `createPdfTextLayerParser({ extract: async () => this })` to
  produce a `ParsedDocument` without carrying a real PDF binary in git.
- `tiny-rulebook.v2.pages.json` — modified version of the same rulebook,
  with an added errata section, used to exercise the supersede + revision
  bump flow.
- `living-rules.html` — a small living-rules page used by the HTML parser
  test and by the URL-ingestion dev smoke test (served from a fixture
  responder if run offline, or from `raw.githubusercontent.com` in CI).

## Why no real PDF here?

The M2 pipeline separates the extractor seam (`PdfExtractor`) from the
deterministic block/heading detection. Real PDFs are large, binary, and
copyright-encumbered. The two `*.pages.json` fixtures let us fully test
the parser + chunker without either problem; the `unpdf` extractor is
exercised in the dev deployment's smoke test against a small synthetic
PDF built at deploy time.
