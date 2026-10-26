import { describe, expect, it } from 'vitest';
import type { ContentPackage, Edition, Game } from '@bgr/domain';
import { asContentId, asEditionId, asGameId } from '@bgr/domain';
import { InMemoryGamesRepository } from './in-memory-games-repository.js';

const iso = '2026-09-16T00:00:00.000Z';

const makeGame = (over: Partial<Game> = {}): Game => ({
  gameId: asGameId('g_ti4'),
  slug: 'twilight-imperium-4',
  name: 'Twilight Imperium 4',
  editions: [],
  createdAt: iso,
  updatedAt: iso,
  ...over,
});

const makeEdition = (over: Partial<Edition> = {}): Edition => ({
  editionId: asEditionId('e_1'),
  gameId: asGameId('g_ti4'),
  name: '4th Edition',
  knowledgeRevision: 0,
  createdAt: iso,
  updatedAt: iso,
  ...over,
});

const makeContent = (over: Partial<ContentPackage> = {}): ContentPackage => ({
  contentId: asContentId('c_pok'),
  gameId: asGameId('g_ti4'),
  editionId: asEditionId('e_1'),
  slug: 'prophecy-of-kings',
  name: 'Prophecy of Kings',
  contentType: 'EXPANSION',
  dependencies: [],
  status: 'READY',
  ...over,
});

describe('InMemoryGamesRepository', () => {
  it('creates and reads back a game', async () => {
    const repo = new InMemoryGamesRepository();
    const g = makeGame();
    await repo.createGame(g);
    expect(await repo.getGame(g.gameId)).toEqual(g);
  });

  it('rejects duplicate slug', async () => {
    const repo = new InMemoryGamesRepository();
    await repo.createGame(makeGame());
    await expect(repo.createGame(makeGame({ gameId: asGameId('g_other') }))).rejects.toThrow(
      /slug/,
    );
  });

  it('searches by prefix in name or slug', async () => {
    const repo = new InMemoryGamesRepository();
    await repo.createGame(makeGame());
    await repo.createGame(makeGame({ gameId: asGameId('g_root'), slug: 'root', name: 'Root' }));
    const res = await repo.searchGames({ query: 'twilight' });
    expect(res.items.map((g) => g.name)).toEqual(['Twilight Imperium 4']);
  });

  it('addEdition appends and updates timestamp', async () => {
    const repo = new InMemoryGamesRepository();
    await repo.createGame(makeGame());
    await repo.addEdition(asGameId('g_ti4'), makeEdition());
    const updated = await repo.getGame(asGameId('g_ti4'));
    expect(updated?.editions).toHaveLength(1);
  });

  it('listContent returns content and forbids duplicates', async () => {
    const repo = new InMemoryGamesRepository();
    await repo.createGame(makeGame());
    await repo.addContent(makeContent());
    expect(await repo.listContent(asGameId('g_ti4'))).toHaveLength(1);
    await expect(repo.addContent(makeContent())).rejects.toThrow();
  });
});
