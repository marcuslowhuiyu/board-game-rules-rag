import type { Chunk, SourceDocumentId } from '@bgr/domain';
import type { ChunksRepository } from './chunks-repository.js';

export class InMemoryChunksRepository implements ChunksRepository {
  private readonly byDoc = new Map<SourceDocumentId, Map<string, Chunk>>();

  async putChunks(chunks: Chunk[]): Promise<void> {
    for (const chunk of chunks) {
      let map = this.byDoc.get(chunk.documentId);
      if (!map) {
        map = new Map();
        this.byDoc.set(chunk.documentId, map);
      }
      map.set(chunk.chunkId, chunk);
    }
  }

  async listChunksForDocument(documentId: SourceDocumentId): Promise<Chunk[]> {
    const map = this.byDoc.get(documentId);
    if (!map) return [];
    return Array.from(map.values()).sort((a, b) => a.ordinal - b.ordinal);
  }

  async deleteChunksForDocument(documentId: SourceDocumentId): Promise<void> {
    this.byDoc.delete(documentId);
  }
}
