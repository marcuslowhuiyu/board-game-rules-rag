import { describe, expect, it, vi } from 'vitest';
import {
  asContentId,
  asEditionId,
  asGameId,
  asSourceDocumentId,
  type SourceDocument,
} from '@bgr/domain';
import type { RetrievedChunk } from '@bgr/retrieval';
import { createLogger } from '@bgr/shared';
import { createSourceLookup } from './sources.js';

const TS = '2026-10-31T00:00:00.000Z';
const doc = (id: string, over: Partial<SourceDocument> = {}): SourceDocument => ({
  documentId: asSourceDocumentId(id),
  gameId: asGameId('g_1'),
  editionId: asEditionId('e_1'),
  contentId: asContentId('c_1'),
  title: `Title ${id}`,
  sourceType: 'RULEBOOK',
  authority: 'OFFICIAL_RULES',
  origin: 'UPLOAD',
  contentHash: 'a'.repeat(64),
  rawObjectUri: `s3://bucket/raw/${id}.pdf`,
  chunkCount: 0,
  status: 'CURRENT',
  supersedes: [],
  knowledgeRevision: 1,
  provenance: [],
  createdAt: TS,
  updatedAt: TS,
  ...over,
});
const chunk = (chunkId: string, documentId: string) =>
  ({ chunkId, documentId, headingPath: [], text: 't' }) as unknown as RetrievedChunk;

describe('createSourceLookup', () => {
  it('fetches each document once, drops and logs chunks whose document is missing, and builds SourceRecords', async () => {
    const docs: Record<string, SourceDocument> = {
      doc_1: doc('doc_1'),
      doc_3: doc('doc_3', { sourceType: 'ERRATA', authority: 'OFFICIAL_ERRATA', version: '2' }),
    };
    const getDocument = vi.fn(async (id: string) => docs[id] ?? null);
    const lines: string[] = [];
    const sources = createSourceLookup({
      getDocument,
      logger: createLogger({ sink: (l) => lines.push(l) }),
    });

    const out = await sources([
      chunk('ch1', 'doc_1'),
      chunk('ch2', 'doc_1'),
      chunk('ch3', 'doc_2'),
      chunk('ch4', 'doc_3'),
    ]);

    expect(getDocument.mock.calls.map((c) => c[0])).toEqual(['doc_1', 'doc_2', 'doc_3']);
    expect([...out.keys()]).toEqual(['ch1', 'ch2', 'ch4']);
    expect(out.get('ch1')).toEqual({
      chunkId: 'ch1',
      authority: 'OFFICIAL_RULES',
      provenance: [],
      title: 'Title doc_1',
      sourceType: 'RULEBOOK',
    });
    expect(out.get('ch4')).toEqual({
      chunkId: 'ch4',
      authority: 'OFFICIAL_ERRATA',
      provenance: [],
      title: 'Title doc_3',
      sourceType: 'ERRATA',
      version: '2',
    });
    expect(lines.map((l) => JSON.parse(l) as Record<string, unknown>)).toEqual([
      expect.objectContaining({
        level: 'warn',
        msg: 'chunk dropped: its document is missing',
        chunkId: 'ch3',
        documentId: 'doc_2',
      }),
    ]);
  });
});
