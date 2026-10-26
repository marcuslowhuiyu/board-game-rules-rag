import type { IngestionSourceRef } from '@bgr/domain';

export interface FetchedSource {
  bytes: Uint8Array;
  contentType: string;
  canonicalUrl?: string;
  filename?: string;
}

export interface DocumentFetcher {
  fetch(source: IngestionSourceRef): Promise<FetchedSource>;
}
