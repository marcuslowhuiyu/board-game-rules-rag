import { describe, expect, it } from 'vitest';
import { createS3UploadPresigner } from './presigner.js';

// Exercises the real @aws-sdk presigner (signing is local, no network) — the
// fake presigner used by handler tests cannot catch SDK default behaviour.
describe('createS3UploadPresigner', () => {
  const presigner = createS3UploadPresigner({
    bucket: 'bgr-ingestion-test',
    region: 'ap-southeast-1',
    expirySeconds: 600,
    maxBytes: 50 * 1024 * 1024,
    credentials: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret' },
  });

  it('does not bake an empty-body checksum into the URL (browser uploads would fail)', async () => {
    const res = await presigner.createPut({
      contentType: 'application/pdf',
      sizeBytes: 1234,
      filename: 'rules.pdf',
    });
    const params = new URL(res.url).searchParams;
    const checksumParams = [...params.keys()].filter((k) =>
      k.toLowerCase().startsWith('x-amz-checksum'),
    );
    expect(checksumParams).toEqual([]);
    expect(params.get('x-amz-sdk-checksum-algorithm')).toBeNull();
  });

  it('signs a PUT for a raw/ key with the requested extension', async () => {
    const res = await presigner.createPut({
      contentType: 'application/pdf',
      sizeBytes: 1234,
      filename: 'rules.pdf',
    });
    expect(res.key).toMatch(/^raw\/\d{4}-\d{2}-\d{2}\/[A-Za-z0-9_-]+\.pdf$/);
    expect(new URL(res.url).pathname).toBe(`/${res.key}`);
    expect(res.maxBytes).toBe(50 * 1024 * 1024);
  });
});
