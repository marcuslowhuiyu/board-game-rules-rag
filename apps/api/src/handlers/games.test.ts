import { describe, expect, it } from 'vitest';
import type { Game } from '@bgr/domain';
import { asContentId, asEditionId, asGameId } from '@bgr/domain';
import { makeHandler } from '../lib/router.js';
import { bodyAs, makeEvent, makeTestContext } from '../test-support.js';
import { gameRoutes } from './games.js';

const NOW = '2026-09-16T00:00:00.000Z';

describe('games handlers', () => {
  const build = () => {
    const ctx = makeTestContext({ now: NOW });
    const handler = makeHandler(gameRoutes(() => ctx));
    return { ctx, handler };
  };

  it('POST /games creates a game with an initial edition', async () => {
    const { ctx, handler } = build();
    const res = await handler(
      makeEvent({
        rawPath: '/games',
        requestContext: {
          http: {
            method: 'POST',
            path: '/games',
            protocol: 'HTTP/1.1',
            sourceIp: '127.0.0.1',
            userAgent: 'vitest',
          },
        } as never,
        body: JSON.stringify({
          name: 'Twilight Imperium 4',
          initialEdition: { name: '4th Edition', publisher: 'FFG' },
        }),
      }),
    );
    expect(res.statusCode).toBe(201);
    const body = bodyAs<Game>(res);
    expect(body.slug).toBe('twilight-imperium-4');
    expect(body.editions).toHaveLength(1);
    expect(body.editions[0]?.name).toBe('4th Edition');
    expect(await ctx.games.getGame(body.gameId)).not.toBeNull();
  });

  it('POST /games rejects an invalid body with 400', async () => {
    const { handler } = build();
    const res = await handler(
      makeEvent({
        rawPath: '/games',
        requestContext: {
          http: {
            method: 'POST',
            path: '/games',
            protocol: 'HTTP/1.1',
            sourceIp: '127.0.0.1',
            userAgent: 'vitest',
          },
        } as never,
        body: JSON.stringify({}),
      }),
    );
    expect(res.statusCode).toBe(400);
  });

  it('POST /games rejects duplicate slug', async () => {
    const { ctx, handler } = build();
    await ctx.games.createGame({
      gameId: asGameId('g_existing'),
      slug: 'root',
      name: 'Root',
      editions: [],
      createdAt: NOW,
      updatedAt: NOW,
    });
    const res = await handler(
      makeEvent({
        rawPath: '/games',
        requestContext: {
          http: {
            method: 'POST',
            path: '/games',
            protocol: 'HTTP/1.1',
            sourceIp: '127.0.0.1',
            userAgent: 'vitest',
          },
        } as never,
        body: JSON.stringify({ name: 'Root' }),
      }),
    );
    expect(res.statusCode).toBe(409);
  });

  it('GET /games returns the seeded catalog', async () => {
    const { ctx, handler } = build();
    await ctx.games.createGame({
      gameId: asGameId('g_ti4'),
      slug: 'twilight-imperium-4',
      name: 'Twilight Imperium 4',
      editions: [],
      createdAt: NOW,
      updatedAt: NOW,
    });
    const res = await handler(makeEvent({ rawPath: '/games' }));
    expect(res.statusCode).toBe(200);
    const body = bodyAs<{ items: Game[] }>(res);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.slug).toBe('twilight-imperium-4');
  });

  it('GET /games?q= filters by needle', async () => {
    const { ctx, handler } = build();
    await ctx.games.createGame({
      gameId: asGameId('g_ti4'),
      slug: 'twilight-imperium-4',
      name: 'Twilight Imperium 4',
      editions: [],
      createdAt: NOW,
      updatedAt: NOW,
    });
    await ctx.games.createGame({
      gameId: asGameId('g_root'),
      slug: 'root',
      name: 'Root',
      editions: [],
      createdAt: NOW,
      updatedAt: NOW,
    });
    const res = await handler(makeEvent({ rawPath: '/games', rawQueryString: 'q=root' }));
    const body = bodyAs<{ items: Game[] }>(res);
    expect(body.items.map((g) => g.slug)).toEqual(['root']);
  });

  it('GET /games/{gameId} returns 404 when missing', async () => {
    const { handler } = build();
    const res = await handler(makeEvent({ rawPath: '/games/g_missing' }));
    expect(res.statusCode).toBe(404);
  });

  it('GET /games/{gameId} includes content packages', async () => {
    const { ctx, handler } = build();
    const gameId = asGameId('g_ti4');
    await ctx.games.createGame({
      gameId,
      slug: 'twilight-imperium-4',
      name: 'Twilight Imperium 4',
      editions: [],
      createdAt: NOW,
      updatedAt: NOW,
    });
    await ctx.games.addContent({
      contentId: asContentId('c_pok'),
      gameId,
      editionId: asEditionId('e_1'),
      slug: 'prophecy-of-kings',
      name: 'Prophecy of Kings',
      contentType: 'EXPANSION',
      dependencies: [],
      status: 'READY',
    });
    const res = await handler(makeEvent({ rawPath: '/games/g_ti4' }));
    expect(res.statusCode).toBe(200);
    const body = bodyAs<{ content: unknown[] }>(res);
    expect(body.content).toHaveLength(1);
  });

  const postGame = (handler: ReturnType<typeof build>['handler'], body: unknown) =>
    handler(
      makeEvent({
        rawPath: '/games',
        requestContext: {
          http: {
            method: 'POST',
            path: '/games',
            protocol: 'HTTP/1.1',
            sourceIp: '127.0.0.1',
            userAgent: 'vitest',
          },
        } as never,
        body: JSON.stringify(body),
      }),
    );

  it('POST /games with an initial edition also creates a READY base content package for it', async () => {
    // Without one, a game added through the app cannot ingest any sources:
    // ingestion requires a contentId and no endpoint creates content.
    const { ctx, handler } = build();
    const res = await postGame(handler, {
      name: 'Cascadia',
      initialEdition: { name: 'First Edition' },
    });
    const game = bodyAs<Game>(res);
    const content = await ctx.games.listContent(game.gameId);
    expect(content).toEqual([
      expect.objectContaining({
        gameId: game.gameId,
        editionId: game.editions[0]!.editionId,
        slug: 'base',
        name: 'Base Game',
        contentType: 'BASE',
        status: 'READY',
      }),
    ]);
  });

  it('POST /games without an edition creates no content', async () => {
    const { ctx, handler } = build();
    const game = bodyAs<Game>(await postGame(handler, { name: 'Azul' }));
    expect(await ctx.games.listContent(game.gameId)).toEqual([]);
  });
});
