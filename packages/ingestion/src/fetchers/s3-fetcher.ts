import type { IngestionSourceRef } from '@bgr/domain';
import type { ObjectStore } from '../storage/object-store.js';
import type { DocumentFetcher, FetchedSource } from './fetcher.js';

/**
 * Fetcher for sources already sitting in our S3 upload bucket (i.e. the
 * bytes that arrived via `POST /uploads/presign` followed by a PUT). Uses
 * the same `ObjectStore` seam as the normalized-text writer.
 */
export function createS3Fetcher(store: ObjectStore): DocumentFetcher {
  return {
    async fetch(source: IngestionSourceRef): Promise<FetchedSource> {
      if (source.kind !== 'S3') {
        throw new Error(`S3 fetcher cannot handle source of kind ${source.kind}`);
      }
      const uri = store.toUri(source.s3Key);
      const bytes = await store.getBytes(uri);
      const result: FetchedSource = { bytes, contentType: source.contentType };
      if (source.filename !== undefined) result.filename = source.filename;
      return result;
    },
  };
}
