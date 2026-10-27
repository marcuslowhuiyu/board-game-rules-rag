import type { EmbeddingsProvider } from '@bgr/ai';
import type { Authority, ContentId, EditionId, GameId, SourceType } from '@bgr/domain';
import type { DocumentsRepository } from '@bgr/persistence';
import { matchesFilter, type VectorFilter, type VectorIndex } from './vector-index.js';

/** A rules question scoped to one session's configuration (MASTER_PLAN §21). */
export interface RetrievalQuery {
  gameId: GameId;
  editionId: EditionId;
  /** Must be non-empty: base content is always enabled in a session. */
  enabledContentIds: readonly ContentId[];
  text: string;
}

export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  gameId: string;
  editionId: string;
  contentId: string;
  authority: Authority;
  sourceType: SourceType;
  headingPath: string[];
  pageStart: number;
  pageEnd: number;
  text: string;
  documentVersion?: string;
  /** Cosine similarity to the question. */
  score: number;
}

/** MASTER_PLAN §20. No rules logic depends on the vector store behind it. */
export interface RulesRetriever {
  retrieve(query: RetrievalQuery): Promise<RetrievedChunk[]>;
}

export class RetrievalQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetrievalQueryError';
  }
}

export interface VectorRulesRetrieverOptions {
  embeddings: EmbeddingsProvider;
  index: VectorIndex;
  documents: Pick<DocumentsRepository, 'listDocumentsForEdition'>;
  /** Candidates per question (config; MASTER_PLAN §21 suggests 10–15). */
  topK: number;
}

/**
 * Retrieves rule chunks for a session. Which documents count is decided in
 * DynamoDB, the source of truth for supersession: only CURRENT documents of
 * the enabled content in the requested edition. Vectors are never rewritten
 * when a document is superseded or reinstated; the query filter names the
 * current documents instead. Every hit is re-checked against that filter
 * before it is returned.
 */
export class VectorRulesRetriever implements RulesRetriever {
  constructor(private readonly options: VectorRulesRetrieverOptions) {}

  async retrieve(query: RetrievalQuery): Promise<RetrievedChunk[]> {
    if (query.enabledContentIds.length === 0) {
      throw new RetrievalQueryError('enabledContentIds must not be empty');
    }
    if (query.text.trim().length === 0) {
      throw new RetrievalQueryError('question text must not be empty');
    }

    const enabled = new Set<string>(query.enabledContentIds);
    const documents = await this.options.documents.listDocumentsForEdition(
      query.gameId,
      query.editionId,
    );
    const current = documents.filter((d) => d.status === 'CURRENT' && enabled.has(d.contentId));
    if (current.length === 0) return [];

    const filter: VectorFilter = {
      gameId: query.gameId,
      editionId: query.editionId,
      documentIds: current.map((d) => d.documentId),
    };
    const { vectors } = await this.options.embeddings.embed([query.text]);
    const hits = await this.options.index.query({
      vector: vectors[0]!,
      topK: this.options.topK,
      filter,
    });

    return hits
      .filter((h) => matchesFilter(h.metadata, filter) && enabled.has(h.metadata.contentId))
      .map((h) => ({
        chunkId: h.key,
        documentId: h.metadata.documentId,
        gameId: h.metadata.gameId,
        editionId: h.metadata.editionId,
        contentId: h.metadata.contentId,
        authority: h.metadata.authority,
        sourceType: h.metadata.sourceType,
        headingPath: h.metadata.headingPath,
        pageStart: h.metadata.pageStart,
        pageEnd: h.metadata.pageEnd,
        text: h.metadata.text,
        ...(h.metadata.documentVersion !== undefined
          ? { documentVersion: h.metadata.documentVersion }
          : {}),
        score: h.score,
      }));
  }
}
