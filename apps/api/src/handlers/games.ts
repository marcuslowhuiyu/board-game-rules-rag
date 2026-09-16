import {
  CreateGameInputSchema,
  GameSchema,
  asEditionId,
  asGameId,
  type ContentPackage,
  type Edition,
  type Game,
} from '@bgr/domain';
import type { AppContext } from '../lib/context.js';
import { conflict, created, notFound, ok } from '../lib/responses.js';
import { parseJsonBody, route, type RequestContext } from '../lib/router.js';

const slugify = (name: string): string =>
  name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || `game-${Date.now()}`;

export function gameRoutes(ctxFactory: () => AppContext) {
  const listGames = async (rc: RequestContext) => {
    const qs = new URLSearchParams(rc.event.rawQueryString ?? '');
    const query = qs.get('q') ?? undefined;
    const limitRaw = qs.get('limit');
    const limit = limitRaw ? Math.min(Math.max(Number(limitRaw), 1), 50) : 20;
    const app = ctxFactory();
    const res = await app.games.searchGames({
      ...(query !== undefined ? { query } : {}),
      limit,
    });
    return ok({
      items: res.items,
      ...(res.nextCursor ? { nextCursor: res.nextCursor } : {}),
    });
  };

  const getGame = async (_rc: RequestContext, params: Record<string, string>) => {
    const app = ctxFactory();
    const gameId = asGameId(params['gameId'] ?? '');
    const game = await app.games.getGame(gameId);
    if (!game) return notFound(`game not found: ${gameId}`);
    const content = await app.games.listContent(gameId);
    return ok<Game & { content: ContentPackage[] }>({ ...game, content });
  };

  const createGame = async (rc: RequestContext) => {
    const app = ctxFactory();
    const input = CreateGameInputSchema.parse(parseJsonBody(rc.event));
    const slug = input.slug ?? slugify(input.name);

    // Slug uniqueness — scan for match. Documented as a M1 simplification in ADR-0006.
    const existing = await app.games.searchGames({ query: slug });
    if (existing.items.some((g) => g.slug === slug)) {
      return conflict(`game with slug already exists: ${slug}`);
    }

    const now = app.clock.now().toISOString();
    const gameId = app.ids.gameId();

    const editions: Edition[] = [];
    if (input.initialEdition) {
      editions.push({
        editionId: asEditionId(app.ids.editionId()),
        gameId: asGameId(gameId),
        name: input.initialEdition.name,
        ...(input.initialEdition.publisher !== undefined
          ? { publisher: input.initialEdition.publisher }
          : {}),
        ...(input.initialEdition.releaseYear !== undefined
          ? { releaseYear: input.initialEdition.releaseYear }
          : {}),
        createdAt: now,
        updatedAt: now,
      });
    }

    const game: Game = GameSchema.parse({
      gameId,
      slug,
      name: input.name,
      ...(input.publisher !== undefined ? { publisher: input.publisher } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      editions,
      createdAt: now,
      updatedAt: now,
    });

    await app.games.createGame(game);
    rc.logger.info('game created', { gameId: game.gameId, slug: game.slug });
    return created(game);
  };

  const listContent = async (_rc: RequestContext, params: Record<string, string>) => {
    const app = ctxFactory();
    const gameId = asGameId(params['gameId'] ?? '');
    const game = await app.games.getGame(gameId);
    if (!game) return notFound(`game not found: ${gameId}`);
    const content = await app.games.listContent(gameId);
    return ok({ items: content });
  };

  return [
    route('GET', '/games', listGames),
    route('POST', '/games', createGame),
    route('GET', '/games/{gameId}', getGame),
    route('GET', '/games/{gameId}/content', listContent),
  ];
}
