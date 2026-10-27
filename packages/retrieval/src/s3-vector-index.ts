import { PutVectorsCommand, QueryVectorsCommand, S3VectorsClient } from '@aws-sdk/client-s3vectors';
import type { DocumentType } from '@smithy/types';
import {
  ChunkVectorMetadataSchema,
  type VectorHit,
  type VectorIndex,
  type VectorItem,
} from './vector-index.js';

/** S3 Vectors service limits (Amazon S3 User Guide, "Limitations and restrictions"). */
const MAX_FILTER_CONSTRAINTS = 100;
const MAX_RESULTS_PER_PAGE = 100;
const MAX_VECTORS_PER_PUT = 500;

export interface S3VectorIndexOptions {
  region: string;
  /** `arn:aws:s3vectors:<region>:<account>:bucket/<bucket>/index/<index>`. */
  indexArn: string;
}

/**
 * `VectorIndex` on Amazon S3 Vectors (ADR-0002). The index uses the cosine
 * distance metric. Queries run in `ENHANCED` mode, which applies the filter
 * before the search, so a narrow filter still returns its true top K.
 */
export class S3VectorIndex implements VectorIndex {
  private readonly client: S3VectorsClient;

  constructor(private readonly options: S3VectorIndexOptions) {
    this.client = new S3VectorsClient({ region: options.region });
  }

  async putVectors(items: readonly VectorItem[]): Promise<void> {
    for (let i = 0; i < items.length; i += MAX_VECTORS_PER_PUT) {
      await this.client.send(
        new PutVectorsCommand({
          indexArn: this.options.indexArn,
          vectors: items.slice(i, i + MAX_VECTORS_PER_PUT).map((item) => ({
            key: item.key,
            data: { float32: item.vector },
            metadata: toServiceMetadata(item.metadata),
          })),
        }),
      );
    }
  }

  async query(input: Parameters<VectorIndex['query']>[0]): Promise<VectorHit[]> {
    const { filter, topK } = input;
    if (!Number.isInteger(topK) || topK < 1 || topK > MAX_RESULTS_PER_PAGE) {
      throw new Error(`topK must be between 1 and ${MAX_RESULTS_PER_PAGE}; got ${topK}`);
    }
    // Each `$eq` counts as one constraint and each `$in` value as one.
    const constraints = 2 + filter.documentIds.length;
    if (constraints > MAX_FILTER_CONSTRAINTS) {
      throw new Error(
        `query needs ${constraints} filter constraints; the limit is ${MAX_FILTER_CONSTRAINTS}`,
      );
    }
    const out = await this.client.send(
      new QueryVectorsCommand({
        indexArn: this.options.indexArn,
        topK,
        queryVector: { float32: input.vector },
        queryMode: 'ENHANCED',
        returnMetadata: true,
        returnDistance: true,
        filter: {
          $and: [
            { gameId: { $eq: filter.gameId } },
            { editionId: { $eq: filter.editionId } },
            { documentId: { $in: [...filter.documentIds] } },
          ],
        },
      }),
    );
    return (out.vectors ?? []).map((v) => {
      // An empty heading path is stored as an absent key (see toServiceMetadata).
      const raw = v.metadata as Record<string, unknown> | undefined;
      const metadata = ChunkVectorMetadataSchema.safeParse(
        raw && !('headingPath' in raw) ? { ...raw, headingPath: [] } : raw,
      );
      if (!v.key || !metadata.success) {
        throw new Error(`vector ${v.key ?? '(no key)'} has invalid metadata`);
      }
      // Cosine distance is 1 - cosine similarity.
      return { key: v.key, score: 1 - (v.distance ?? 1), metadata: metadata.data };
    });
  }
}

/**
 * S3 Vectors metadata is a JSON document that cannot hold `undefined` or an
 * empty array, so those fields are omitted. A chunk before a document's first
 * heading has an empty heading path.
 */
function toServiceMetadata(metadata: object): Record<string, DocumentType> {
  return Object.fromEntries(
    Object.entries(metadata).filter(
      ([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0),
    ),
  ) as Record<string, DocumentType>;
}
