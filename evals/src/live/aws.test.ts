import type { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { readChunkBody } from './aws.js';

const s3With = (body: unknown) =>
  ({ send: async () => ({ Body: body }) }) as unknown as Pick<S3Client, 'send'>;

describe('readChunkBody', () => {
  it('returns the chunk body as UTF-8 text', async () => {
    const s3 = s3With({ transformToString: async () => 'Draw two cards.' });
    await expect(readChunkBody(s3, 's3://bucket/normalized/doc_1/chk_1.txt')).resolves.toBe(
      'Draw two cards.',
    );
  });

  it('throws on a missing body instead of embedding an empty chunk', async () => {
    await expect(
      readChunkBody(s3With(undefined), 's3://bucket/normalized/doc_1/chk_1.txt'),
    ).rejects.toThrow('empty body reading s3://bucket/normalized/doc_1/chk_1.txt');
  });

  it('rejects a text URI that is not s3://bucket/key', async () => {
    await expect(readChunkBody(s3With(undefined), 'https://example.com/x')).rejects.toThrow(
      'bad textUri https://example.com/x',
    );
  });
});
