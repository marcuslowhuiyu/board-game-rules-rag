import type { ParsedDocument } from '../types.js';

export interface DocumentParser {
  /**
   * Parse the raw bytes of a document into normalized blocks + a quality
   * report. Implementations must not throw for empty / malformed input —
   * they surface those conditions through `quality.warnings` so the pipeline
   * can decide to route to a fallback parser.
   */
  parse(bytes: Uint8Array, hints: ParserHints): Promise<ParsedDocument>;
}

export interface ParserHints {
  contentType: string;
  filename?: string;
  canonicalUrl?: string;
}
