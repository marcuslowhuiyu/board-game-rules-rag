import { createHash } from 'node:crypto';

/** SHA-256 hex of the given bytes. Used as the ingestion dedup key. */
export function sha256Hex(bytes: Uint8Array | string): string {
  const h = createHash('sha256');
  h.update(bytes);
  return h.digest('hex');
}
