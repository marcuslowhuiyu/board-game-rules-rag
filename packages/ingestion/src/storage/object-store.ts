/**
 * Object storage seam. Ingestion Lambdas write raw source + normalized chunk
 * text through this interface so the pipeline can be exercised end-to-end
 * without S3 in unit tests. The real S3 implementation lives in `apps/api`
 * where it can pick up the injected AWS SDK client.
 */
export interface ObjectStore {
  putBytes(key: string, body: Uint8Array | string, contentType: string): Promise<{ uri: string }>;
  getBytes(uri: string): Promise<Uint8Array>;
  getText(uri: string): Promise<string>;
  toUri(key: string): string;
}
