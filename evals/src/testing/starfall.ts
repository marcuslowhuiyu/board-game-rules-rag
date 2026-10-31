import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { SourceDocumentSchema, type SourceDocument } from '@bgr/domain';
import { InMemoryDocumentsRepository } from '@bgr/persistence';
import { InMemoryVectorIndex } from '@bgr/retrieval';
import type { EvalGames } from '../run-eval.js';
import { HashEmbedder } from './hash-embedder.js';

export const fixturePath = (path: string): string =>
  fileURLToPath(new URL(`../../fixtures/${path}`, import.meta.url));

interface Corpus {
  game: { key: string; gameId: string; editionId: string; content: Record<string, string> };
  documents: Array<
    Pick<SourceDocument, 'documentId' | 'contentId' | 'status' | 'sourceType' | 'authority'>
  >;
  chunks: Array<{ chunkId: string; documentId: string; headingPath: string[]; text: string }>;
}

/**
 * The invented game "Starfall" (`fixtures/retrieval/synthetic-corpus.json`) in memory: its
 * documents, its chunks in an exact vector index embedded with the hash embedder, and its
 * eval-games entry. No AWS, no network.
 */
export async function loadStarfall() {
  const corpus = JSON.parse(
    await readFile(fixturePath('retrieval/synthetic-corpus.json'), 'utf8'),
  ) as Corpus;
  const { gameId, editionId } = corpus.game;
  const documents = new InMemoryDocumentsRepository();
  for (const d of corpus.documents) {
    documents.putDocument(
      SourceDocumentSchema.parse({
        ...d,
        gameId,
        editionId,
        title: d.documentId,
        origin: 'UPLOAD',
        contentHash: 'a'.repeat(64),
        rawObjectUri: `s3://fixture/${d.documentId}`,
        chunkCount: 0,
        supersedes: [],
        knowledgeRevision: 1,
        createdAt: '2026-10-27T00:00:00.000Z',
        updatedAt: '2026-10-27T00:00:00.000Z',
      }),
    );
  }
  const embeddings = new HashEmbedder();
  const index = new InMemoryVectorIndex();
  const { vectors } = await embeddings.embed(corpus.chunks.map((c) => c.text));
  await index.putVectors(
    corpus.chunks.map((c, i) => {
      const doc = corpus.documents.find((d) => d.documentId === c.documentId)!;
      return {
        key: c.chunkId,
        vector: vectors[i]!,
        metadata: {
          gameId,
          editionId,
          contentId: doc.contentId,
          documentId: c.documentId,
          authority: doc.authority,
          sourceType: doc.sourceType,
          headingPath: c.headingPath,
          pageStart: 1,
          pageEnd: 1,
          text: c.text,
        },
      };
    }),
  );
  const games: EvalGames = {
    [corpus.game.key]: {
      gameId,
      editionId,
      content: { base: corpus.game.content['base']! },
      chunks: corpus.chunks.length,
    },
  };
  return { documents, embeddings, index, games };
}
