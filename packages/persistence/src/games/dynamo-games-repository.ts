import {
  ConflictError,
  GameSchema,
  ContentPackageSchema,
  type ContentPackage,
  type Edition,
  type Game,
  type GameId,
} from '@bgr/domain';
import { ConditionalCheckFailedException, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { GameSearchOptions, GameSearchResult, GamesRepository } from './games-repository.js';

export interface DynamoGamesTables {
  gamesTable: string;
  contentTable: string;
}

export class DynamoGamesRepository implements GamesRepository {
  private readonly doc: DynamoDBDocumentClient;

  constructor(
    client: DynamoDBClient,
    private readonly tables: DynamoGamesTables,
  ) {
    this.doc = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true },
    });
  }

  async createGame(game: Game): Promise<Game> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tables.gamesTable,
          Item: game,
          ConditionExpression: 'attribute_not_exists(gameId)',
        }),
      );
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        throw new ConflictError(`game already exists: ${game.gameId}`);
      }
      throw err;
    }
    return game;
  }

  async getGame(gameId: GameId): Promise<Game | null> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.tables.gamesTable, Key: { gameId } }),
    );
    if (!res.Item) return null;
    return GameSchema.parse(res.Item);
  }

  async searchGames({ query, limit = 20 }: GameSearchOptions): Promise<GameSearchResult> {
    const needle = query?.trim().toLowerCase();
    // Simple scan for M1 (small catalog, seeded). ADR-0006 documents the
    // upgrade path: a name-prefix GSI or an external index once the catalog
    // outgrows scan.
    const res = await this.doc.send(
      new ScanCommand({
        TableName: this.tables.gamesTable,
        Limit: Math.min(Math.max(limit * 4, limit), 200),
      }),
    );
    const all = (res.Items ?? []).map((i) => GameSchema.parse(i));
    const filtered = needle
      ? all.filter(
          (g) => g.name.toLowerCase().includes(needle) || g.slug.toLowerCase().includes(needle),
        )
      : all;
    filtered.sort((a, b) => a.name.localeCompare(b.name));
    return { items: filtered.slice(0, limit) };
  }

  async addEdition(gameId: GameId, edition: Edition): Promise<void> {
    // Editions live embedded on the game row. Read-modify-write is fine at M1
    // scale (games are updated infrequently and by a single operator).
    const current = await this.getGame(gameId);
    if (!current) throw new ConflictError(`game does not exist: ${gameId}`);
    const editions = [
      ...current.editions.filter((e) => e.editionId !== edition.editionId),
      edition,
    ];
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tables.gamesTable,
        Key: { gameId },
        UpdateExpression: 'SET editions = :editions, updatedAt = :updatedAt',
        ExpressionAttributeValues: {
          ':editions': editions,
          ':updatedAt': edition.updatedAt,
        },
      }),
    );
  }

  async listContent(gameId: GameId): Promise<ContentPackage[]> {
    const res = await this.doc.send(
      new QueryCommand({
        TableName: this.tables.contentTable,
        KeyConditionExpression: 'gameId = :gameId',
        ExpressionAttributeValues: { ':gameId': gameId },
      }),
    );
    return (res.Items ?? []).map((i) => ContentPackageSchema.parse(i));
  }

  async addContent(pkg: ContentPackage): Promise<void> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tables.contentTable,
          Item: pkg,
          ConditionExpression: 'attribute_not_exists(contentId)',
        }),
      );
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        throw new ConflictError(`content already exists: ${pkg.contentId}`);
      }
      throw err;
    }
  }
}
