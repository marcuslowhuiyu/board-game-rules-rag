import type { ObjectStore } from './object-store.js';

/**
 * In-memory `ObjectStore`. `uri` is `mem://<bucket>/<key>`. Not persisted;
 * every instance starts empty.
 */
export class InMemoryObjectStore implements ObjectStore {
  private readonly items = new Map<string, { bytes: Uint8Array; contentType: string }>();

  constructor(private readonly bucket: string = 'test-bucket') {}

  toUri(key: string): string {
    return `mem://${this.bucket}/${key}`;
  }

  async putBytes(
    key: string,
    body: Uint8Array | string,
    contentType: string,
  ): Promise<{ uri: string }> {
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(body);
    this.items.set(key, { bytes, contentType });
    return { uri: this.toUri(key) };
  }

  async getBytes(uri: string): Promise<Uint8Array> {
    const key = this.parseKey(uri);
    const entry = this.items.get(key);
    if (!entry) throw new Error(`no such object: ${uri}`);
    return entry.bytes;
  }

  async getText(uri: string): Promise<string> {
    const bytes = await this.getBytes(uri);
    return new TextDecoder('utf-8').decode(bytes);
  }

  private parseKey(uri: string): string {
    const prefix = `mem://${this.bucket}/`;
    if (!uri.startsWith(prefix)) throw new Error(`uri not owned by this store: ${uri}`);
    return uri.slice(prefix.length);
  }
}
