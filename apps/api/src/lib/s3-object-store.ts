import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { ObjectStore } from '@bgr/ingestion';

export interface S3ObjectStoreOptions {
  bucket: string;
  region?: string;
}

/**
 * Real `ObjectStore` backed by S3. Keys are relative (`raw/…`,
 * `normalized/…`); URIs are `s3://bucket/key` for legibility.
 */
export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;

  constructor(private readonly options: S3ObjectStoreOptions) {
    this.client = new S3Client(options.region ? { region: options.region } : {});
  }

  toUri(key: string): string {
    return `s3://${this.options.bucket}/${key}`;
  }

  async putBytes(
    key: string,
    body: Uint8Array | string,
    contentType: string,
  ): Promise<{ uri: string }> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        Body: typeof body === 'string' ? Buffer.from(body, 'utf-8') : Buffer.from(body),
        ContentType: contentType,
      }),
    );
    return { uri: this.toUri(key) };
  }

  async getBytes(uri: string): Promise<Uint8Array> {
    const key = this.parseKey(uri);
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.options.bucket, Key: key }),
    );
    if (!res.Body) throw new Error(`empty body reading ${uri}`);
    const chunks: Uint8Array[] = [];
    for await (const chunk of res.Body as AsyncIterable<Uint8Array>) chunks.push(chunk);
    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return out;
  }

  async getText(uri: string): Promise<string> {
    const bytes = await this.getBytes(uri);
    return new TextDecoder('utf-8').decode(bytes);
  }

  private parseKey(uri: string): string {
    const prefix = `s3://${this.options.bucket}/`;
    if (!uri.startsWith(prefix)) throw new Error(`uri not owned by this store: ${uri}`);
    return uri.slice(prefix.length);
  }
}
