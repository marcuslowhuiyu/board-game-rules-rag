import { describe, expect, it } from 'vitest';
import {
  asContentId,
  asEditionId,
  asGameId,
  asSourceDocumentId,
  type SourceDocument,
} from '@bgr/domain';
import type { EmbeddingsProvider } from '@bgr/ai';
import { InMemoryDocumentsRepository } from '@bgr/persistence';
import { InMemoryVectorIndex } from './in-memory-vector-index.js';
import { RetrievalQueryError, VectorRulesRetriever } from './vector-rules-retriever.js';
import type { ChunkVectorMetadata, VectorIndex } from './vector-index.js';

const WORDS = [
  'trains',
  'route',
  'ticket',
  'bird',
  'food',
  'egg',
  'probe',
  'orbit',
  'card',
  'score',
];

/** Deterministic stand-in for Titan: one dimension per known word. */
class WordCountEmbeddings implements EmbeddingsProvider {
  readonly modelId = 'test-words';
  readonly dimensions = WORDS.length;
  calls = 0;
  async embed(texts: readonly string[]) {
    this.calls++;
    const vectors = texts.map((t) => {
      const words = t.toLowerCase().split(/\W+/);
      const v = WORDS.map((w) => words.filter((x) => x === w).length);
      return v.every((x) => x === 0) ? v.map(() => 0.01) : v;
    });
    return { vectors, inputTokens: 0 };
  }
}

const iso = '2026-10-27T00:00:00.000Z';

function doc(
  id: string,
  over: {
    game?: string;
    edition?: string;
    content?: string;
    status?: SourceDocument['status'];
  } = {},
): SourceDocument {
  return {
    documentId: asSourceDocumentId(id),
    gameId: asGameId(over.game ?? 'g_ttr'),
    editionId: asEditionId(over.edition ?? 'e_1'),
    contentId: asContentId(over.content ?? 'c_base'),
    title: id,
    sourceType: 'RULEBOOK',
    authority: 'OFFICIAL_RULES',
    origin: 'UPLOAD',
    contentHash: 'a'.repeat(64),
    rawObjectUri: `s3://raw/${id}`,
    chunkCount: 1,
    status: over.status ?? 'CURRENT',
    supersedes: [],
    provenance: [],
    knowledgeRevision: 1,
    createdAt: iso,
    updatedAt: iso,
  };
}

function metaFor(d: SourceDocument, text: string): ChunkVectorMetadata {
  return {
    gameId: d.gameId,
    editionId: d.editionId,
    contentId: d.contentId,
    documentId: d.documentId,
    authority: d.authority,
    sourceType: d.sourceType,
    headingPath: ['Rules'],
    pageStart: 1,
    pageEnd: 1,
    text,
  };
}

async function setup(
  docs: SourceDocument[],
  chunks: { key: string; doc: SourceDocument; text: string }[],
) {
  const documents = new InMemoryDocumentsRepository();
  for (const d of docs) await documents.createDocument(d);
  const embeddings = new WordCountEmbeddings();
  const index = new InMemoryVectorIndex();
  const { vectors } = await embeddings.embed(chunks.map((c) => c.text));
  await index.putVectors(
    chunks.map((c, i) => ({ key: c.key, vector: vectors[i]!, metadata: metaFor(c.doc, c.text) })),
  );
  embeddings.calls = 0;
  const retriever = new VectorRulesRetriever({ embeddings, index, documents, topK: 12 });
  return { retriever, embeddings, documents, index };
}

const query = (over: Partial<Parameters<VectorRulesRetriever['retrieve']>[0]> = {}) => ({
  gameId: asGameId('g_ttr'),
  editionId: asEditionId('e_1'),
  enabledContentIds: [asContentId('c_base')],
  text: 'how many trains',
  ...over,
});

describe('VectorRulesRetriever', () => {
  it('returns the closest chunks of the current documents, best first, with provenance', async () => {
    const base = doc('doc_base');
    const { retriever } = await setup(
      [base],
      [
        { key: 'ch_trains', doc: base, text: 'Each player takes 45 trains.' },
        { key: 'ch_ticket', doc: base, text: 'Draw a destination ticket card.' },
      ],
    );

    const hits = await retriever.retrieve(query());

    expect(hits.map((h) => h.chunkId)).toEqual(['ch_trains', 'ch_ticket']);
    expect(hits[0]).toMatchObject({
      chunkId: 'ch_trains',
      documentId: 'doc_base',
      contentId: 'c_base',
      text: 'Each player takes 45 trains.',
      headingPath: ['Rules'],
      pageStart: 1,
      authority: 'OFFICIAL_RULES',
    });
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
  });

  it('never returns chunks of a superseded document', async () => {
    const v1 = doc('doc_v1', { status: 'SUPERSEDED' });
    const v2 = doc('doc_v2');
    const { retriever } = await setup(
      [v1, v2],
      [
        { key: 'ch_old', doc: v1, text: 'trains trains trains' },
        { key: 'ch_new', doc: v2, text: 'Each player takes 45 trains.' },
      ],
    );

    const hits = await retriever.retrieve(query());
    expect(hits.map((h) => h.chunkId)).toEqual(['ch_new']);
  });

  it('returns nothing, without embedding the question, when no enabled content has a current document', async () => {
    const promo = doc('doc_promo', { content: 'c_promo' });
    const { retriever, embeddings } = await setup(
      [promo],
      [{ key: 'ch_promo', doc: promo, text: 'trains' }],
    );

    expect(await retriever.retrieve(query())).toEqual([]);
    expect(embeddings.calls).toBe(0);
  });

  it('requires enabled content and a question', async () => {
    const { retriever, embeddings } = await setup([doc('doc_base')], []);
    await expect(retriever.retrieve(query({ enabledContentIds: [] }))).rejects.toThrow(
      RetrievalQueryError,
    );
    await expect(retriever.retrieve(query({ text: '  ' }))).rejects.toThrow(RetrievalQueryError);
    expect(embeddings.calls).toBe(0);
  });

  it('drops any hit the index returns outside the filter', async () => {
    const base = doc('doc_base');
    const stray = doc('doc_stray', { game: 'g_other' });
    const leakyIndex: VectorIndex = {
      putVectors: async () => {},
      query: async () => [
        { key: 'ch_stray', score: 0.99, metadata: metaFor(stray, 'trains') },
        { key: 'ch_ok', score: 0.5, metadata: metaFor(base, 'trains') },
      ],
    };
    const documents = new InMemoryDocumentsRepository();
    await documents.createDocument(base);
    const retriever = new VectorRulesRetriever({
      embeddings: new WordCountEmbeddings(),
      index: leakyIndex,
      documents,
      topK: 12,
    });

    const hits = await retriever.retrieve(query());
    expect(hits.map((h) => h.chunkId)).toEqual(['ch_ok']);
  });

  describe('properties (seeded random corpora)', () => {
    /** Small deterministic PRNG so failures reproduce. */
    function rng(seed: number) {
      let s = seed;
      return () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    }
    const pick = <T>(r: () => number, xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
    const sentence = (r: () => number) =>
      Array.from({ length: 1 + Math.floor(r() * 5) }, () => pick(r, WORDS)).join(' ');

    async function randomCorpus(seed: number) {
      const r = rng(seed);
      const docs = [
        doc('doc_base_e1'),
        doc('doc_promo_e1', { content: 'c_promo' }),
        doc('doc_old_e1', { status: 'SUPERSEDED' }),
        doc('doc_base_e2', { edition: 'e_2' }),
        doc('doc_promo_e2', { edition: 'e_2', content: 'c_promo' }),
      ];
      const chunks = Array.from({ length: 60 }, (_, i) => ({
        key: `ch_${i}`,
        doc: pick(r, docs),
        text: sentence(r),
      }));
      return { r, ...(await setup(docs, chunks)) };
    }

    it('with a promo disabled, never returns a chunk from that promo', async () => {
      for (let seed = 1; seed <= 25; seed++) {
        const { r, retriever } = await randomCorpus(seed);
        const edition = pick(r, ['e_1', 'e_2']);
        const hits = await retriever.retrieve(
          query({ editionId: asEditionId(edition), text: sentence(r) }),
        );
        expect(hits.length, `seed ${seed}`).toBeGreaterThan(0);
        for (const h of hits) expect(h.contentId, `seed ${seed}`).toBe('c_base');
      }
    });

    it('only returns chunks from the requested edition, and never from superseded documents', async () => {
      for (let seed = 1; seed <= 25; seed++) {
        const { r, retriever } = await randomCorpus(seed);
        const edition = pick(r, ['e_1', 'e_2']);
        const hits = await retriever.retrieve(
          query({
            editionId: asEditionId(edition),
            enabledContentIds: [asContentId('c_base'), asContentId('c_promo')],
            text: sentence(r),
          }),
        );
        for (const h of hits) {
          expect(h.editionId, `seed ${seed}`).toBe(edition);
          expect(h.documentId, `seed ${seed}`).not.toBe('doc_old_e1');
        }
      }
    });
  });
});
