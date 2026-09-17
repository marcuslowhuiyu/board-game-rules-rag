import {
  ConflictError,
  NotFoundError,
  type ContentPackage,
  type Edition,
  type EditionId,
  type Game,
  type GameId,
} from '@bgr/domain';
import type { GameSearchOptions, GameSearchResult, GamesRepository } from './games-repository.js';

export class InMemoryGamesRepository implements GamesRepository {
  private readonly games = new Map<GameId, Game>();
  private readonly contentByGame = new Map<GameId, ContentPackage[]>();

  async createGame(game: Game): Promise<Game> {
    for (const existing of this.games.values()) {
      if (existing.slug === game.slug) {
        throw new ConflictError(`game with slug already exists: ${game.slug}`);
      }
    }
    this.games.set(game.gameId, game);
    return game;
  }

  async getGame(gameId: GameId): Promise<Game | null> {
    return this.games.get(gameId) ?? null;
  }

  async searchGames({ query, limit = 20 }: GameSearchOptions): Promise<GameSearchResult> {
    const needle = query?.trim().toLowerCase();
    const all = Array.from(this.games.values()).sort((a, b) => a.name.localeCompare(b.name));
    const filtered = needle
      ? all.filter(
          (g) => g.name.toLowerCase().includes(needle) || g.slug.toLowerCase().includes(needle),
        )
      : all;
    return { items: filtered.slice(0, limit) };
  }

  async addEdition(gameId: GameId, edition: Edition): Promise<void> {
    const existing = this.games.get(gameId);
    if (!existing) throw new ConflictError(`game does not exist: ${gameId}`);
    const editions = [
      ...existing.editions.filter((e) => e.editionId !== edition.editionId),
      edition,
    ];
    this.games.set(gameId, { ...existing, editions, updatedAt: edition.updatedAt });
  }

  async listContent(gameId: GameId): Promise<ContentPackage[]> {
    return [...(this.contentByGame.get(gameId) ?? [])];
  }

  async addContent(pkg: ContentPackage): Promise<void> {
    const existing = this.contentByGame.get(pkg.gameId) ?? [];
    if (existing.some((c) => c.contentId === pkg.contentId)) {
      throw new ConflictError(`content already exists: ${pkg.contentId}`);
    }
    this.contentByGame.set(pkg.gameId, [...existing, pkg]);
  }

  async bumpKnowledgeRevision(
    gameId: GameId,
    editionId: EditionId,
    updatedAt: string,
  ): Promise<number> {
    const existing = this.games.get(gameId);
    if (!existing) throw new NotFoundError('game', gameId);
    const idx = existing.editions.findIndex((e) => e.editionId === editionId);
    if (idx === -1) throw new NotFoundError('edition', editionId);
    const edition = existing.editions[idx]!;
    const nextRevision = edition.knowledgeRevision + 1;
    const editions = existing.editions.slice();
    editions[idx] = { ...edition, knowledgeRevision: nextRevision, updatedAt };
    this.games.set(gameId, { ...existing, editions, updatedAt });
    return nextRevision;
  }

  async replaceEditions(
    gameId: GameId,
    editions: readonly Edition[],
    updatedAt: string,
    expectedUpdatedAt: string,
  ): Promise<void> {
    const existing = this.games.get(gameId);
    if (!existing) throw new NotFoundError('game', gameId);
    if (existing.updatedAt !== expectedUpdatedAt) {
      throw new ConflictError(
        `game ${gameId} updatedAt ${existing.updatedAt} != expected ${expectedUpdatedAt}`,
      );
    }
    this.games.set(gameId, {
      ...existing,
      editions: editions.slice(),
      updatedAt,
    });
  }
}
