import { describe, expect, it } from 'vitest';
import { asContentId, asEditionId, asGameId, type ContentPackage, type Game } from '@bgr/domain';
import { makeHandler } from '../lib/router.js';
import { bodyAs, makeEvent, makeFakeExecutor, makeTestContext } from '../test-support.js';
import { ingestionRoutes } from './ingestion.js';

const NOW = '2026-09-17T00:00:00.000Z';

async function seedGame(ctx: ReturnType<typeof makeTestContext>) {
  const gameId = asGameId('g_ti4');
  const editionId = asEditionId('e_1');
  const contentId = asContentId('c_base');
  const game: Game = {
    gameId,
    slug: 'twilight-imperium-4',
    name: 'Twilight Imperium 4',
    editions: [
      {
        editionId,
        gameId,
        name: '4th Edition',
        knowledgeRevision: 0,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    createdAt: NOW,
    updatedAt: NOW,
  };
  await ctx.games.createGame(game);
  const content: ContentPackage = {
    contentId,
    gameId,
    editionId,
    slug: 'base',
    name: 'Base Game',
    contentType: 'BASE',
    dependencies: [],
    status: 'READY',
  };
  await ctx.games.addContent(content);
  return { gameId, editionId, contentId };
}

const build = () => {
  const executor = makeFakeExecutor();
  const ctx = makeTestContext({ executor });
  const handler = makeHandler(ingestionRoutes(() => ctx));
  return { ctx, executor, handler };
};

const postJson = (path: string, body: Record<string, unknown>) =>
  makeEvent({
    rawPath: path,
    body: JSON.stringify(body),
    requestContext: {
      accountId: '0',
      apiId: 'x',
      domainName: 'x',
      domainPrefix: 'x',
      http: { method: 'POST', path, protocol: 'HTTP/1.1', sourceIp: '0.0.0.0', userAgent: 'v' },
      requestId: 'r',
      routeKey: `POST ${path}`,
      stage: '$default',
      time: 't',
      timeEpoch: 0,
    },
  });

describe('POST /ingestion', () => {
  it('creates a PENDING job, starts the executor, and returns the view', async () => {
    const { ctx, executor, handler } = build();
    const { gameId, editionId, contentId } = await seedGame(ctx);
    await ctx.rawStore.putBytes(
      'raw/2026-09-17/x.pdf',
      new Uint8Array([1, 2, 3]),
      'application/pdf',
    );
    const res = await handler(
      postJson('/ingestion', {
        gameId,
        editionId,
        contentId,
        title: 'Base Rulebook',
        sourceType: 'RULEBOOK',
        authority: 'OFFICIAL_RULES',
        source: {
          kind: 'S3',
          s3Key: 'raw/2026-09-17/x.pdf',
          contentType: 'application/pdf',
        },
      }),
    );
    expect(res.statusCode).toBe(201);
    const body = bodyAs<{ jobId: string; status: string; stage: string }>(res);
    expect(body.jobId).toMatch(/^job_/);
    expect(body.status).toBe('PENDING');
    expect(body.stage).toBe('VALIDATE');
    expect(executor.started).toHaveLength(1);
  });

  it('rejects an S3 source whose object is missing', async () => {
    const { ctx, handler } = build();
    const { gameId, editionId, contentId } = await seedGame(ctx);
    const res = await handler(
      postJson('/ingestion', {
        gameId,
        editionId,
        contentId,
        title: 'X',
        sourceType: 'RULEBOOK',
        authority: 'OFFICIAL_RULES',
        source: { kind: 'S3', s3Key: 'raw/missing.pdf', contentType: 'application/pdf' },
      }),
    );
    expect(res.statusCode).toBe(400);
  });

  it('rejects an unknown gameId', async () => {
    const { handler } = build();
    const res = await handler(
      postJson('/ingestion', {
        gameId: 'g_missing',
        editionId: 'e_1',
        contentId: 'c_base',
        title: 'X',
        sourceType: 'RULEBOOK',
        authority: 'OFFICIAL_RULES',
        source: { kind: 'URL', url: 'https://ok.example.com/x' },
      }),
    );
    expect(res.statusCode).toBe(400);
  });

  it('marks the job FAILED and returns 400 when the executor cannot start', async () => {
    const { ctx, executor, handler } = build();
    executor.shouldFail = true;
    const { gameId, editionId, contentId } = await seedGame(ctx);
    await ctx.rawStore.putBytes('raw/2026-09-17/y.pdf', new Uint8Array([1]), 'application/pdf');
    const res = await handler(
      postJson('/ingestion', {
        gameId,
        editionId,
        contentId,
        title: 'X',
        sourceType: 'RULEBOOK',
        authority: 'OFFICIAL_RULES',
        source: {
          kind: 'S3',
          s3Key: 'raw/2026-09-17/y.pdf',
          contentType: 'application/pdf',
        },
      }),
    );
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /ingestion/{jobId}', () => {
  it('returns the current job state', async () => {
    const { ctx, handler } = build();
    const { gameId, editionId, contentId } = await seedGame(ctx);
    await ctx.rawStore.putBytes(
      'raw/2026-09-17/x.pdf',
      new Uint8Array([1, 2, 3]),
      'application/pdf',
    );
    const created = await handler(
      postJson('/ingestion', {
        gameId,
        editionId,
        contentId,
        title: 'Base',
        sourceType: 'RULEBOOK',
        authority: 'OFFICIAL_RULES',
        source: {
          kind: 'S3',
          s3Key: 'raw/2026-09-17/x.pdf',
          contentType: 'application/pdf',
        },
      }),
    );
    const body = bodyAs<{ jobId: string }>(created);
    const path = `/ingestion/${body.jobId}`;
    const get = await handler(
      makeEvent({
        rawPath: path,
        requestContext: {
          accountId: '0',
          apiId: 'x',
          domainName: 'x',
          domainPrefix: 'x',
          http: { method: 'GET', path, protocol: 'HTTP/1.1', sourceIp: '0.0.0.0', userAgent: 'v' },
          requestId: 'r',
          routeKey: `GET ${path}`,
          stage: '$default',
          time: 't',
          timeEpoch: 0,
        },
      }),
    );
    expect(get.statusCode).toBe(200);
    const fetched = bodyAs<{ jobId: string; status: string; stage: string }>(get);
    expect(fetched.jobId).toBe(body.jobId);
    expect(fetched.stage).toBe('VALIDATE');
  });

  it('returns 404 for an unknown jobId', async () => {
    const { handler } = build();
    const path = '/ingestion/job_missing';
    const res = await handler(
      makeEvent({
        rawPath: path,
        requestContext: {
          accountId: '0',
          apiId: 'x',
          domainName: 'x',
          domainPrefix: 'x',
          http: { method: 'GET', path, protocol: 'HTTP/1.1', sourceIp: '0.0.0.0', userAgent: 'v' },
          requestId: 'r',
          routeKey: `GET ${path}`,
          stage: '$default',
          time: 't',
          timeEpoch: 0,
        },
      }),
    );
    expect(res.statusCode).toBe(404);
  });
});
