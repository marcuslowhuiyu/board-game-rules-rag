import type { SourceDocument } from '@bgr/domain';
import type { Logger } from '@bgr/shared';
import type { AnswerPipelineDeps, SourceRecord } from './pipeline.js';

/**
 * The pipeline's `sources` step, the one way the Lambda and the eval share: each distinct
 * document is fetched once per call, a chunk whose document is missing is dropped with a
 * warning, and each kept chunk gets the document facts the answerer prompt shows. Wrap
 * `getDocument` to add a cache (the Lambda keeps one per run).
 */
export function createSourceLookup(deps: {
  getDocument: (documentId: string) => Promise<SourceDocument | null>;
  logger: Logger;
}): AnswerPipelineDeps['sources'] {
  return async (chunks) => {
    const docs = new Map<string, SourceDocument | null>();
    for (const id of new Set(chunks.map((c) => c.documentId))) {
      docs.set(id, await deps.getDocument(id));
    }
    const out = new Map<string, SourceRecord>();
    for (const c of chunks) {
      const doc = docs.get(c.documentId);
      if (!doc) {
        deps.logger.warn('chunk dropped: its document is missing', {
          chunkId: c.chunkId,
          documentId: c.documentId,
        });
        continue;
      }
      out.set(c.chunkId, {
        chunkId: c.chunkId,
        authority: doc.authority,
        provenance: doc.provenance,
        title: doc.title,
        sourceType: doc.sourceType,
        ...(doc.version === undefined ? {} : { version: doc.version }),
      });
    }
    return out;
  };
}
