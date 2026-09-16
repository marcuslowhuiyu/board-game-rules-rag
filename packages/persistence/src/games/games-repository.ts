import type { ContentPackage, Edition, Game, GameId } from '@bgr/domain';

/** Result of a game search — total is best-effort ("at least this many"). */
export interface GameSearchResult {
  items: Game[];
  nextCursor?: string;
}

export interface GameSearchOptions {
  query?: string;
  limit?: number;
  cursor?: string;
}

export interface GamesRepository {
  /** Create a new Game. Fails with ConflictError if the slug already exists. */
  createGame(game: Game): Promise<Game>;
  /** Get a Game by id. Returns null if not found. Editions are embedded on the record. */
  getGame(gameId: GameId): Promise<Game | null>;
  /** List/search games. Prefix match on name (case-insensitive) when query is set. */
  searchGames(options: GameSearchOptions): Promise<GameSearchResult>;
  /** Attach an edition to an existing game. */
  addEdition(gameId: GameId, edition: Edition): Promise<void>;
  /** List content packages for a game. */
  listContent(gameId: GameId): Promise<ContentPackage[]>;
  /** Insert a content package. */
  addContent(pkg: ContentPackage): Promise<void>;
}
