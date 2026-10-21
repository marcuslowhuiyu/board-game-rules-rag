import type { ContentPackage, Edition, EditionId, Game, GameId } from '@bgr/domain';

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
  /**
   * Create a new Game together with its initial content packages, all or
   * nothing: a game must never exist without the content it was created with
   * (no endpoint can add it later). Fails with ConflictError if the game or
   * any content package already exists.
   */
  createGame(game: Game, initialContent?: readonly ContentPackage[]): Promise<Game>;
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
  /**
   * Atomically bump the knowledgeRevision for a specific edition and return
   * the new revision number. Fails if the edition is not present.
   * See MASTER_PLAN §19 — called by the Finalize ingestion stage.
   *
   * NOTE: FINALIZE now prefers the atomic `AtomicPublisher.publishDocument`
   * path so the revision bump commits in the same DDB transaction as the
   * new-document publish and the previous-document supersede; direct callers
   * of `bumpKnowledgeRevision` are legacy paths and dev fixture scripts.
   */
  bumpKnowledgeRevision(gameId: GameId, editionId: EditionId, updatedAt: string): Promise<number>;
  /**
   * Overwrite a game's editions array with `editions` and set `updatedAt` to
   * `updatedAt`, but only if the game's current `updatedAt` still matches
   * `expectedUpdatedAt`. Used by the atomic publisher; direct call sites
   * should prefer `bumpKnowledgeRevision`.
   * Throws a `ConflictError` if the row moved underneath us.
   */
  replaceEditions(
    gameId: GameId,
    editions: readonly Edition[],
    updatedAt: string,
    expectedUpdatedAt: string,
  ): Promise<void>;
}
