import { describe, expect, it } from 'vitest';
import {
  asContentId,
  asEditionId,
  asGameId,
  asSourceDocumentId,
  type SourceDocument,
} from '@bgr/domain';
import { InMemoryDocumentsRepository } from './in-memory-documents-repository.js';

const iso = '2026-09-17T00:00:00.000Z';

const makeDoc = (over: Partial<SourceDocument> = {}): SourceDocument => ({
  documentId: asSourceDocumentId('doc_1'),
  gameId: asGameId('g_ti4'),
  editionId: asEditionId('e_1'),
  contentId: asContentId('c_base'),
  title: 'Base Rulebook',
  sourceType: 'RULEBOOK',
  authority: 'OFFICIAL_RULES',
  origin: 'UPLOAD',
  contentHash: 'a'.repeat(64),
  rawObjectUri: 's3://bucket/raw/doc_1.pdf',
  chunkCount: 0,
  status: 'CURRENT',
  supersedes: [],
  knowledgeRevision: 0,
  createdAt: iso,
  updatedAt: iso,
  ...over,
});

describe('InMemoryDocumentsRepository', () => {
  it('createDocument then getDocument round-trips', async () => {
    const repo = new InMemoryDocumentsRepository();
    const doc = makeDoc();
    await repo.createDocument(doc);
    expect(await repo.getDocument(doc.documentId)).toEqual(doc);
  });

  it('createDocument throws on duplicate id', async () => {
    const repo = new InMemoryDocumentsRepository();
    await repo.createDocument(makeDoc());
    await expect(repo.createDocument(makeDoc())).rejects.toThrow(/document already exists/);
  });

  it('findByContentHash matches on (game, edition, contentId, contentHash)', async () => {
    const repo = new InMemoryDocumentsRepository();
    await repo.createDocument(makeDoc());
    const found = await repo.findByContentHash(
      asGameId('g_ti4'),
      asEditionId('e_1'),
      asContentId('c_base'),
      'a'.repeat(64),
    );
    expect(found?.documentId).toBe('doc_1');
    const miss = await repo.findByContentHash(
      asGameId('g_ti4'),
      asEditionId('e_1'),
      asContentId('c_base'),
      'b'.repeat(64),
    );
    expect(miss).toBeNull();
  });

  it('findByContentHash does NOT collapse identical bytes across different contentIds', async () => {
    const repo = new InMemoryDocumentsRepository();
    await repo.createDocument(
      makeDoc({
        documentId: asSourceDocumentId('doc_base'),
        contentId: asContentId('c_base'),
      }),
    );
    await repo.createDocument(
      makeDoc({
        documentId: asSourceDocumentId('doc_promo'),
        contentId: asContentId('c_promo'),
      }),
    );
    const baseHit = await repo.findByContentHash(
      asGameId('g_ti4'),
      asEditionId('e_1'),
      asContentId('c_base'),
      'a'.repeat(64),
    );
    const promoHit = await repo.findByContentHash(
      asGameId('g_ti4'),
      asEditionId('e_1'),
      asContentId('c_promo'),
      'a'.repeat(64),
    );
    expect(baseHit?.documentId).toBe('doc_base');
    expect(promoHit?.documentId).toBe('doc_promo');
  });

  it('findCurrentByKey ignores SUPERSEDED documents', async () => {
    const repo = new InMemoryDocumentsRepository();
    await repo.createDocument(makeDoc({ status: 'SUPERSEDED' }));
    const found = await repo.findCurrentByKey(
      asGameId('g_ti4'),
      asEditionId('e_1'),
      asContentId('c_base'),
      'RULEBOOK',
    );
    expect(found).toBeNull();
  });

  it('markSuperseded flips status', async () => {
    const repo = new InMemoryDocumentsRepository();
    await repo.createDocument(makeDoc());
    await repo.markSuperseded(asSourceDocumentId('doc_1'), '2026-10-01T00:00:00.000Z');
    const doc = await repo.getDocument(asSourceDocumentId('doc_1'));
    expect(doc?.status).toBe('SUPERSEDED');
    expect(doc?.updatedAt).toBe('2026-10-01T00:00:00.000Z');
  });

  it('listDocumentsForEdition filters by edition', async () => {
    const repo = new InMemoryDocumentsRepository();
    await repo.createDocument(makeDoc({ documentId: asSourceDocumentId('doc_1') }));
    await repo.createDocument(
      makeDoc({ documentId: asSourceDocumentId('doc_2'), editionId: asEditionId('e_2') }),
    );
    const list = await repo.listDocumentsForEdition(asGameId('g_ti4'), asEditionId('e_1'));
    expect(list.map((d) => d.documentId)).toEqual(['doc_1']);
  });
});
