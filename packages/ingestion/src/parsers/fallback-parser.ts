import type { ParsedDocument } from '../types.js';
import type { DocumentParser } from './parser.js';

/**
 * Stubbed fallback parser. The concrete OCR / AI implementation is deferred
 * to a later milestone with a dedicated ADR — see MASTER_PLAN §16. This
 * placeholder makes the interface explicit so callers can wire in a real
 * implementation without touching the pipeline.
 */
export function createStubFallbackParser(): DocumentParser {
  return {
    async parse(): Promise<ParsedDocument> {
      throw new Error(
        'fallback document parser is not implemented — deterministic PDF text-layer parsing is the only supported path in M2',
      );
    },
  };
}
