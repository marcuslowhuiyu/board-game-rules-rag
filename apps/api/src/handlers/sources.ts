import { ChunkSchema, SourceDocumentSchema, asSourceDocumentId } from '@bgr/domain';
import type { AppContext } from '../lib/context.js';
import { notFound, ok } from '../lib/responses.js';
import { route, type RequestContext } from '../lib/router.js';

export function sourceRoutes(ctxFactory: () => AppContext) {
  const getSource = async (_rc: RequestContext, params: Record<string, string>) => {
    const app = ctxFactory();
    const sourceId = asSourceDocumentId(params['sourceId'] ?? '');
    const doc = await app.documents.getDocument(sourceId);
    if (!doc) return notFound(`source document not found: ${sourceId}`);
    return ok(SourceDocumentSchema.parse(doc));
  };

  const listSourceChunks = async (_rc: RequestContext, params: Record<string, string>) => {
    const app = ctxFactory();
    const sourceId = asSourceDocumentId(params['sourceId'] ?? '');
    const doc = await app.documents.getDocument(sourceId);
    if (!doc) return notFound(`source document not found: ${sourceId}`);
    const chunks = await app.chunks.listChunksForDocument(sourceId);
    return ok({ items: chunks.map((c) => ChunkSchema.parse(c)) });
  };

  return [
    route('GET', '/sources/{sourceId}', getSource),
    route('GET', '/sources/{sourceId}/chunks', listSourceChunks),
  ];
}
