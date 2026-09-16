import {
  CreateSessionInputSchema,
  SessionSchema,
  SessionViewSchema,
  asSessionId,
  configurationFingerprint,
  type Session,
} from '@bgr/domain';
import type { AppContext } from '../lib/context.js';
import { buildExpiredSessionCookie, buildSessionCookie } from '../lib/cookies.js';
import { badRequest, created, noContent, notFound, ok } from '../lib/responses.js';
import { parseJsonBody, route, type RequestContext } from '../lib/router.js';

export function sessionRoutes(ctxFactory: () => AppContext) {
  const createSession = async (rc: RequestContext) => {
    const app = ctxFactory();
    const input = CreateSessionInputSchema.parse(parseJsonBody(rc.event));

    const game = await app.games.getGame(input.gameId);
    if (!game) return badRequest(`unknown gameId: ${input.gameId}`);
    if (!game.editions.some((e) => e.editionId === input.editionId)) {
      return badRequest(`unknown editionId for game ${input.gameId}: ${input.editionId}`);
    }
    // Content ids must:
    //   (a) belong to this game,
    //   (b) belong to the specific edition being started,
    //   (c) be in a usable state (`READY`).
    // Rejecting DRAFT/ARCHIVED content here keeps retrieval (M3+) from picking
    // up rules from content the operator has not yet approved.
    const content = await app.games.listContent(input.gameId);
    const eligible = new Map(
      content
        .filter((c) => c.editionId === input.editionId && c.status === 'READY')
        .map((c) => [c.contentId, c] as const),
    );
    for (const cid of input.enabledContentIds) {
      const pkg = content.find((c) => c.contentId === cid);
      if (!pkg) {
        return badRequest(`unknown enabledContentId for game ${input.gameId}: ${cid}`);
      }
      if (pkg.editionId !== input.editionId) {
        return badRequest(
          `content ${cid} belongs to edition ${pkg.editionId}, not ${input.editionId}`,
        );
      }
      if (pkg.status !== 'READY') {
        return badRequest(`content ${cid} is not READY (current status: ${pkg.status})`);
      }
      if (!eligible.has(cid)) {
        return badRequest(`enabledContentId not eligible: ${cid}`);
      }
    }

    const now = app.clock.now();
    const nowIso = now.toISOString();
    const expiresMs = now.getTime() + app.config.sessionTtlSeconds * 1000;
    const expiresIso = new Date(expiresMs).toISOString();
    const ttl = Math.floor(expiresMs / 1000);

    const sessionId = asSessionId(app.ids.sessionId());

    const session: Session = SessionSchema.parse({
      sessionId,
      gameId: input.gameId,
      editionId: input.editionId,
      enabledContentIds: input.enabledContentIds,
      configurationFingerprint: configurationFingerprint(
        input.gameId,
        input.editionId,
        input.enabledContentIds,
      ),
      createdAt: nowIso,
      updatedAt: nowIso,
      expiresAt: expiresIso,
      ttl,
    });

    await app.sessions.createSession(session);
    rc.logger.info('session created', {
      sessionId: session.sessionId,
      gameId: session.gameId,
    });

    return created(SessionViewSchema.parse(session), {
      cookies: [buildSessionCookie(session.sessionId, app.config.sessionTtlSeconds)],
    });
  };

  const getSession = async (_rc: RequestContext, params: Record<string, string>) => {
    const app = ctxFactory();
    const sessionId = asSessionId(params['sessionId'] ?? '');
    const session = await app.sessions.getSession(sessionId);
    if (!session) return notFound(`session not found: ${sessionId}`);
    return ok(SessionViewSchema.parse(session));
  };

  const deleteSession = async (_rc: RequestContext, params: Record<string, string>) => {
    const app = ctxFactory();
    const sessionId = asSessionId(params['sessionId'] ?? '');
    await app.sessions.deleteSession(sessionId);
    return noContent({ cookies: [buildExpiredSessionCookie()] });
  };

  return [
    route('POST', '/sessions', createSession),
    route('GET', '/sessions/{sessionId}', getSession),
    route('DELETE', '/sessions/{sessionId}', deleteSession),
  ];
}
