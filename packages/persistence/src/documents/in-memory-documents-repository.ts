import {
  ConflictError,
  NotFoundError,
  type ContentId,
  type EditionId,
  type GameId,
  type SourceDocument,
  type SourceDocumentId,
  type SourceType,
} from '@bgr/domain';
import type { DocumentsRepository } from './documents-repository.js';

export class InMemoryDocumentsRepository implements DocumentsRepository {
  private readonly byId = new Map<SourceDocumentId, SourceDocument>();

  async createDocument(doc: SourceDocument): Promise<void> {
    if (this.byId.has(doc.documentId)) {
      throw new ConflictError(`document already exists: ${doc.documentId}`);
    }
    this.byId.set(doc.documentId, { ...doc });
  }

  async getDocument(documentId: SourceDocumentId): Promise<SourceDocument | null> {
    return this.peekDocument(documentId);
  }

  /** Synchronous read for `InMemoryAtomicPublisher`'s yield-free check-and-apply. */
  peekDocument(documentId: SourceDocumentId): SourceDocument | null {
    return this.byId.get(documentId) ?? null;
  }

  /** Unconditional overwrite — the publisher's reinstate path checks first. */
  putDocument(doc: SourceDocument): void {
    this.byId.set(doc.documentId, { ...doc });
  }

  async listDocumentsForEdition(gameId: GameId, editionId: EditionId): Promise<SourceDocument[]> {
    return Array.from(this.byId.values()).filter(
      (d) => d.gameId === gameId && d.editionId === editionId,
    );
  }

  async findByContentHash(
    gameId: GameId,
    editionId: EditionId,
    contentId: ContentId,
    contentHash: string,
  ): Promise<SourceDocument | null> {
    for (const d of this.byId.values()) {
      if (
        d.gameId === gameId &&
        d.editionId === editionId &&
        d.contentId === contentId &&
        d.contentHash === contentHash
      ) {
        return d;
      }
    }
    return null;
  }

  async findCurrentByKey(
    gameId: GameId,
    editionId: EditionId,
    contentId: ContentId,
    sourceType: SourceType,
  ): Promise<SourceDocument | null> {
    for (const d of this.byId.values()) {
      if (
        d.gameId === gameId &&
        d.editionId === editionId &&
        d.contentId === contentId &&
        d.sourceType === sourceType &&
        d.status === 'CURRENT'
      ) {
        return d;
      }
    }
    return null;
  }

  async markSuperseded(documentId: SourceDocumentId, updatedAt: string): Promise<void> {
    const doc = this.byId.get(documentId);
    if (!doc) throw new NotFoundError('sourceDocument', documentId);
    this.byId.set(documentId, { ...doc, status: 'SUPERSEDED', updatedAt });
  }

  async updateChunkCount(
    documentId: SourceDocumentId,
    chunkCount: number,
    updatedAt: string,
  ): Promise<void> {
    const doc = this.byId.get(documentId);
    if (!doc) throw new NotFoundError('sourceDocument', documentId);
    this.byId.set(documentId, { ...doc, chunkCount, updatedAt });
  }
}
