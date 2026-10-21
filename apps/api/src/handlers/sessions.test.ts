import { describe, expect, it } from 'vitest';
import {
  asContentId,
  asEditionId,
  asGameId,
  configurationFingerprint,
  type SessionView,
} from '@bgr/domain';
import { makeHandler } from '../lib/router.js';
import { bodyAs, makeEvent, makeTestContext } from '../test-support.js';
import { sessionRoutes } from './sessions.js';

// Future-dated to keep the session's 24h TTL from expiring against wall-clock
// checks in `InMemorySessionsRepository.getSession` when tests run after
// 2026-09-17.
const NOW = '2099-01-01T00:00:00.000Z';

const seedGame = async (
  ctx: ReturnType<typeof makeTestContext>,
  opts: { includeContent?: boolean } = {},
) => {
  const gameId = asGameId('g_ti4');
  const editionId = asEditionId('e_1');
  await ctx.games.createGame({
    gameId,
    slug: 'twilight-imperium-4',
    name: 'Twilight Imperium 4',
    editions: [
      {
        editionId,
        gameId,
        name: '4th Edition',
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    createdAt: NOW,
    updatedAt: NOW,
  });
  if (opts.includeContent) {
    await ctx.games.addContent({
      contentId: asContentId('c_pok'),
      gameId,
      editionId,
      slug: 'prophecy-of-kings',
      name: 'Prophecy of Kings',
      contentType: 'EXPANSION',
      dependencies: [],
      status: 'READY',
    });
  }
  return { gameId, editionId };
};

const post = (body: unknown) =>
  makeEvent({
    rawPath: '/sessions',
    requestContext: {
      http: {
        method: 'POST',
        path: '/sessions',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'vitest',
      },
    } as never,
    body: JSON.stringify(body),
  });

describe('sessions handlers', () => {
  const build = () => {
    const ctx = makeTestContext({ now: NOW });
    const handler = makeHandler(sessionRoutes(() => ctx));
    return { ctx, handler };
  };

  it('POST /sessions creates a session with a fingerprint and a session cookie', async () => {
    const { ctx, handler } = build();
    const { gameId, editionId } = await seedGame(ctx, { includeContent: true });

    const res = await handler(
      post({ gameId, editionId, enabledContentIds: [asContentId('c_pok')] }),
    );
    expect(res.statusCode).toBe(201);
    const body = bodyAs<SessionView>(res);
    expect(body.gameId).toBe(gameId);
    expect(body.configurationFingerprint).toBe(
      configurationFingerprint(gameId, editionId, [asContentId('c_pok')]),
    );
    expect(res.cookies).toBeDefined();
    const cookie = res.cookies?.[0] ?? '';
    expect(cookie).toMatch(/^bgr_session=/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');

    // Session persisted.
    const stored = await ctx.sessions.getSession(body.sessionId);
    expect(stored?.gameId).toBe(gameId);
    // TTL ~ 24 hours ahead.
    const nowMs = new Date(NOW).getTime();
    expect(stored!.ttl * 1000 - nowMs).toBeCloseTo(86_400_000, -3);
  });

  it('POST /sessions rejects unknown gameId', async () => {
    const { handler } = build();
    const res = await handler(
      post({ gameId: asGameId('g_missing'), editionId: asEditionId('e_1') }),
    );
    expect(res.statusCode).toBe(400);
  });

  it('POST /sessions rejects unknown editionId', async () => {
    const { ctx, handler } = build();
    const { gameId } = await seedGame(ctx);
    const res = await handler(post({ gameId, editionId: asEditionId('e_missing') }));
    expect(res.statusCode).toBe(400);
  });

  it('POST /sessions rejects unknown enabledContentId', async () => {
    const { ctx, handler } = build();
    const { gameId, editionId } = await seedGame(ctx);
    const res = await handler(
      post({ gameId, editionId, enabledContentIds: [asContentId('c_bogus')] }),
    );
    expect(res.statusCode).toBe(400);
  });

  it('POST /sessions rejects content that belongs to a different edition', async () => {
    const { ctx, handler } = build();
    const gameId = asGameId('g_ti4');
    const editionOne = asEditionId('e_1');
    const editionTwo = asEditionId('e_2');
    await ctx.games.createGame({
      gameId,
      slug: 'twilight-imperium-4',
      name: 'Twilight Imperium 4',
      editions: [
        { editionId: editionOne, gameId, name: '4th Edition', createdAt: NOW, updatedAt: NOW },
        {
          editionId: editionTwo,
          gameId,
          name: 'Legendary Edition',
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      createdAt: NOW,
      updatedAt: NOW,
    });
    // Content package belongs to edition 2 only.
    await ctx.games.addContent({
      contentId: asContentId('c_legendary'),
      gameId,
      editionId: editionTwo,
      slug: 'legendary-only',
      name: 'Legendary Only',
      contentType: 'EXPANSION',
      dependencies: [],
      status: 'READY',
    });

    const res = await handler(
      post({
        gameId,
        editionId: editionOne,
        enabledContentIds: [asContentId('c_legendary')],
      }),
    );
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body ?? '{}') as { error: { message: string } };
    expect(body.error.message).toMatch(/belongs to edition/);
  });

  it('POST /sessions rejects content that is not READY', async () => {
    const { ctx, handler } = build();
    const { gameId, editionId } = await seedGame(ctx);
    await ctx.games.addContent({
      contentId: asContentId('c_draft'),
      gameId,
      editionId,
      slug: 'work-in-progress',
      name: 'Work In Progress',
      contentType: 'EXPANSION',
      dependencies: [],
      status: 'DRAFT',
    });

    const res = await handler(
      post({ gameId, editionId, enabledContentIds: [asContentId('c_draft')] }),
    );
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body ?? '{}') as { error: { message: string } };
    expect(body.error.message).toMatch(/not READY/);
  });

  it('GET /sessions/{sessionId} returns the persisted session', async () => {
    const { ctx, handler } = build();
    const { gameId, editionId } = await seedGame(ctx);
    const create = await handler(post({ gameId, editionId }));
    const created = bodyAs<SessionView>(create);
    const res = await handler(makeEvent({ rawPath: `/sessions/${created.sessionId}` }));
    expect(res.statusCode).toBe(200);
    const body = bodyAs<SessionView>(res);
    expect(body.sessionId).toBe(created.sessionId);
  });

  it('GET /sessions/{sessionId} returns 404 for missing session', async () => {
    const { handler } = build();
    const res = await handler(makeEvent({ rawPath: '/sessions/s_missing' }));
    expect(res.statusCode).toBe(404);
  });

  it('DELETE /sessions/{sessionId} clears the cookie and removes the session', async () => {
    const { ctx, handler } = build();
    const { gameId, editionId } = await seedGame(ctx);
    const create = await handler(post({ gameId, editionId }));
    const created = bodyAs<SessionView>(create);
    const res = await handler(
      makeEvent({
        rawPath: `/sessions/${created.sessionId}`,
        requestContext: {
          http: {
            method: 'DELETE',
            path: `/sessions/${created.sessionId}`,
            protocol: 'HTTP/1.1',
            sourceIp: '127.0.0.1',
            userAgent: 'vitest',
          },
        } as never,
      }),
    );
    expect(res.statusCode).toBe(204);
    const cookie = res.cookies?.[0] ?? '';
    expect(cookie).toContain('Max-Age=0');
    expect(await ctx.sessions.getSession(created.sessionId)).toBeNull();
  });
});
