import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import { handler, type HealthBody } from './health.js';

const makeEvent = (): APIGatewayProxyEventV2 =>
  ({
    version: '2.0',
    routeKey: 'GET /health',
    rawPath: '/health',
    rawQueryString: '',
    headers: {},
    requestContext: {
      accountId: '000000000000',
      apiId: 'test',
      domainName: 'test.example.com',
      domainPrefix: 'test',
      http: {
        method: 'GET',
        path: '/health',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'vitest',
      },
      requestId: 'req-1',
      routeKey: 'GET /health',
      stage: '$default',
      time: '15/Sep/2026:00:00:00 +0000',
      timeEpoch: 1789603200000,
    },
    isBase64Encoded: false,
  }) as APIGatewayProxyEventV2;

describe('health handler', () => {
  it('returns 200 with a well-formed JSON body', async () => {
    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(200);
    expect(result.headers?.['content-type']).toBe('application/json');
    expect(result.body).toBeDefined();

    const parsed = JSON.parse(result.body as string) as HealthBody;
    expect(parsed.status).toBe('ok');
    expect(typeof parsed.commit).toBe('string');
    expect(() => new Date(parsed.time).toISOString()).not.toThrow();
  });

  it('surfaces GIT_COMMIT when the environment provides it', async () => {
    const previous = process.env.GIT_COMMIT;
    process.env.GIT_COMMIT = 'deadbeef';
    try {
      const result = await handler(makeEvent());
      const parsed = JSON.parse(result.body as string) as HealthBody;
      expect(parsed.commit).toBe('deadbeef');
    } finally {
      if (previous === undefined) delete process.env.GIT_COMMIT;
      else process.env.GIT_COMMIT = previous;
    }
  });
});
