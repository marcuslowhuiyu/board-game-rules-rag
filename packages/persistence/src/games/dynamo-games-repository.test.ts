import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  ConflictError,
  asContentId,
  asEditionId,
  asGameId,
  type ContentPackage,
  type Edition,
  type Game,
} from '@bgr/domain';
import { DynamoGamesRepository } from './dynamo-games-repository.js';

const iso = '2026-09-16T00:00:00.000Z';

const tables = { gamesTable: 'games', contentTable: 'content' };

const game: Game = {
  gameId: asGameId('g_ti4'),
  slug: 'twilight-imperium-4',
  name: 'Twilight Imperium 4',
  editions: [],
  createdAt: iso,
  updatedAt: iso,
};

const edition: Edition = {
  editionId: asEditionId('e_1'),
  gameId: asGameId('g_ti4'),
  name: '4th Edition',
  createdAt: iso,
  updatedAt: iso,
};

const content: ContentPackage = {
  contentId: asContentId('c_pok'),
  gameId: asGameId('g_ti4'),
  editionId: asEditionId('e_1'),
  slug: 'prophecy-of-kings',
  name: 'Prophecy of Kings',
  contentType: 'EXPANSION',
  dependencies: [],
  status: 'READY',
};

describe('DynamoGamesRepository', () => {
  const docMock = mockClient(DynamoDBDocumentClient);

  beforeEach(() => docMock.reset());

  const makeRepo = () => new DynamoGamesRepository(new DynamoDBClient({}), tables);

  it('createGame sends a conditional Put', async () => {
    docMock.on(PutCommand).resolves({});
    await makeRepo().createGame(game);
    const calls = docMock.commandCalls(PutCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input).toMatchObject({
      TableName: 'games',
      ConditionExpression: 'attribute_not_exists(gameId)',
    });
  });

  it('createGame maps ConditionalCheckFailed to ConflictError', async () => {
    docMock
      .on(PutCommand)
      .rejects(new ConditionalCheckFailedException({ $metadata: {}, message: 'cond' }));
    await expect(makeRepo().createGame(game)).rejects.toBeInstanceOf(ConflictError);
  });

  it('getGame returns null when the item is absent', async () => {
    docMock.on(GetCommand).resolves({});
    expect(await makeRepo().getGame(asGameId('g_missing'))).toBeNull();
  });

  it('getGame parses the item through the schema', async () => {
    docMock.on(GetCommand).resolves({ Item: game });
    expect(await makeRepo().getGame(game.gameId)).toEqual(game);
  });

  it('searchGames filters by needle across name and slug', async () => {
    const another: Game = {
      ...game,
      gameId: asGameId('g_root'),
      slug: 'root',
      name: 'Root',
    };
    docMock.on(ScanCommand).resolves({ Items: [game, another] });
    const res = await makeRepo().searchGames({ query: 'twilight' });
    expect(res.items).toEqual([game]);
  });

  it('addEdition reads then writes the merged editions array', async () => {
    docMock.on(GetCommand).resolves({ Item: game });
    docMock.on(UpdateCommand).resolves({});
    await makeRepo().addEdition(asGameId('g_ti4'), edition);
    const calls = docMock.commandCalls(UpdateCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input.ExpressionAttributeValues?.[':editions']).toEqual([edition]);
  });

  it('listContent queries by gameId', async () => {
    docMock.on(QueryCommand).resolves({ Items: [content] });
    const items = await makeRepo().listContent(asGameId('g_ti4'));
    expect(items).toEqual([content]);
    const calls = docMock.commandCalls(QueryCommand);
    expect(calls[0]!.args[0].input).toMatchObject({
      TableName: 'content',
      KeyConditionExpression: 'gameId = :gameId',
    });
  });

  it('addContent conditional put maps conflicts', async () => {
    docMock
      .on(PutCommand)
      .rejects(new ConditionalCheckFailedException({ $metadata: {}, message: 'cond' }));
    await expect(makeRepo().addContent(content)).rejects.toBeInstanceOf(ConflictError);
  });
});
