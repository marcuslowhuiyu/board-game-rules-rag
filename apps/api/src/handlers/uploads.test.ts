import { describe, expect, it } from 'vitest';
import { makeHandler } from '../lib/router.js';
import { bodyAs, makeEvent, makeFakePresigner, makeTestContext } from '../test-support.js';
import { uploadRoutes } from './uploads.js';

const build = () => {
  const presigner = makeFakePresigner();
  const ctx = makeTestContext({ presigner });
  const handler = makeHandler(uploadRoutes(() => ctx));
  return { ctx, presigner, handler };
};

const post = (body: Record<string, unknown>) =>
  makeEvent({
    rawPath: '/uploads/presign',
    body: JSON.stringify(body),
    requestContext: {
      accountId: '0',
      apiId: 'x',
      domainName: 'x',
      domainPrefix: 'x',
      http: {
        method: 'POST',
        path: '/uploads/presign',
        protocol: 'HTTP/1.1',
        sourceIp: '0.0.0.0',
        userAgent: 'v',
      },
      requestId: 'r',
      routeKey: 'POST /uploads/presign',
      stage: '$default',
      time: 't',
      timeEpoch: 0,
    },
  });

describe('POST /uploads/presign', () => {
  it('returns a presigned PUT for allowed content types', async () => {
    const { handler, presigner } = build();
    const res = await handler(
      post({ filename: 'rulebook.pdf', contentType: 'application/pdf', sizeBytes: 1024 }),
    );
    expect(res.statusCode).toBe(200);
    const body = bodyAs<{ url: string; key: string; method: string }>(res);
    expect(body.method).toBe('PUT');
    expect(body.url).toMatch(/^https:\/\//);
    expect(body.key).toMatch(/^raw\//);
    expect(presigner.calls[0]?.contentType).toBe('application/pdf');
  });

  it('rejects disallowed content types', async () => {
    const { handler } = build();
    const res = await handler(
      post({ filename: 'evil.exe', contentType: 'application/x-msdownload', sizeBytes: 10 }),
    );
    expect(res.statusCode).toBe(400);
    expect((res.body ?? '').toLowerCase()).toContain('disallowed');
  });

  it('rejects payloads that exceed the size cap', async () => {
    const { handler } = build();
    const res = await handler(
      post({ filename: 'x.pdf', contentType: 'application/pdf', sizeBytes: 200 * 1024 * 1024 }),
    );
    expect(res.statusCode).toBe(400);
  });
});
