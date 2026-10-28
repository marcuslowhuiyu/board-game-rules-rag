import { describe, expect, it } from 'vitest';
import type { ProvenanceEvidence, SourceDocument } from '@bgr/domain';
import { asContentId, asEditionId, asGameId, asSourceDocumentId } from '@bgr/domain';
import { makeHandler } from '../lib/router.js';
import { bodyAs, makeEvent, makeTestContext } from '../test-support.js';
import { sourceRoutes } from './sources.js';

const NOW = '2026-09-16T00:00:00.000Z';

const baseDoc = (): SourceDocument => ({
  documentId: asSourceDocumentId('doc_1'),
  gameId: asGameId('g_1'),
  editionId: asEditionId('e_1'),
  contentId: asContentId('c_1'),
  title: 'Rulebook',
  sourceType: 'RULEBOOK',
  authority: 'OFFICIAL_RULES',
  origin: 'UPLOAD',
  contentHash: 'a'.repeat(64),
  rawObjectUri: 's3://bucket/raw/doc_1.pdf',
  chunkCount: 0,
  status: 'CURRENT',
  supersedes: [],
  knowledgeRevision: 1,
  provenance: [],
  createdAt: NOW,
  updatedAt: NOW,
});

describe('sources handlers', () => {
  const build = () => {
    const ctx = makeTestContext({ now: NOW });
    const handler = makeHandler(sourceRoutes(() => ctx));
    return { ctx, handler };
  };
  const get = (handler: ReturnType<typeof build>['handler'], id: string) =>
    handler(makeEvent({ rawPath: `/sources/${id}` }));

  it('GET /sources/{id} returns provenance', async () => {
    const { ctx, handler } = build();
    const provenance: ProvenanceEvidence[] = [
      { kind: 'OPERATOR_ATTESTED', authority: 'OFFICIAL_RULES', recordedAt: NOW },
      { kind: 'UPLOADED_FILE', filename: 'rules.pdf' },
    ];
    await ctx.documents.createDocument({ ...baseDoc(), provenance });
    const res = await get(handler, 'doc_1');
    expect(res.statusCode).toBe(200);
    expect(bodyAs<SourceDocument>(res).provenance).toEqual(provenance);
  });

  it('GET /sources/{id} for a legacy document returns provenance: []', async () => {
    const { ctx, handler } = build();
    const { provenance: _omit, ...legacy } = baseDoc();
    await ctx.documents.createDocument(legacy as SourceDocument);
    const res = await get(handler, 'doc_1');
    expect(res.statusCode).toBe(200);
    expect(bodyAs<SourceDocument>(res).provenance).toEqual([]);
  });
});
