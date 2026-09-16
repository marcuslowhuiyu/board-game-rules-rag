import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import type { Game, GameWithContent, SessionView } from './api/client.js';

const now = '2026-09-16T00:00:00.000Z';

const seededGame: GameWithContent = {
  gameId: 'g_ti4',
  slug: 'twilight-imperium-4',
  name: 'Twilight Imperium 4',
  publisher: 'FFG',
  editions: [
    {
      editionId: 'e_1',
      gameId: 'g_ti4',
      name: '4th Edition',
      createdAt: now,
      updatedAt: now,
    },
  ],
  content: [
    {
      contentId: 'c_pok',
      gameId: 'g_ti4',
      editionId: 'e_1',
      slug: 'prophecy-of-kings',
      name: 'Prophecy of Kings',
      contentType: 'EXPANSION',
      dependencies: [],
      status: 'READY',
    },
  ],
  createdAt: now,
  updatedAt: now,
};

const gameSummary: Game = {
  gameId: seededGame.gameId,
  slug: seededGame.slug,
  name: seededGame.name,
  publisher: seededGame.publisher!,
  editions: seededGame.editions,
  createdAt: now,
  updatedAt: now,
};

function stubFetch(
  routes: Record<string, (init: RequestInit | undefined) => { status?: number; body?: unknown }>,
): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const key = `${(init?.method ?? 'GET').toUpperCase()} ${new URL(url).pathname}${
        new URL(url).search
      }`;
      const bareKey = `${(init?.method ?? 'GET').toUpperCase()} ${new URL(url).pathname}`;
      const match = routes[key] ?? routes[bareKey];
      if (!match) throw new Error(`unrouted: ${key}`);
      const res = match(init);
      const status = res.status ?? 200;
      const body = res.body === undefined ? '' : JSON.stringify(res.body);
      return new Response(body, {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

describe('App', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the header', async () => {
    stubFetch({ 'GET /games': () => ({ body: { items: [] } }) });
    render(<App apiUrl="https://api.test" />);
    expect(screen.getByRole('heading', { name: /board game rules referee/i })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/no games yet/i)).toBeInTheDocument());
  });

  it('flows from search → configure → start session', async () => {
    const captured: { sessionCalls: unknown[] } = { sessionCalls: [] };
    stubFetch({
      'GET /games': () => ({ body: { items: [gameSummary] } }),
      'GET /games/g_ti4': () => ({ body: seededGame }),
      'POST /sessions': (init) => {
        captured.sessionCalls.push(JSON.parse((init?.body as string) ?? '{}'));
        const session: SessionView = {
          sessionId: 's_test',
          gameId: 'g_ti4',
          editionId: 'e_1',
          enabledContentIds: ['c_pok'],
          configurationFingerprint: 'x'.repeat(64),
          createdAt: now,
          updatedAt: now,
          expiresAt: now,
        };
        return { status: 201, body: session };
      },
    });

    const user = userEvent.setup();
    render(<App apiUrl="https://api.test" />);

    // See the seeded game and click it.
    const item = await screen.findByRole('button', {
      name: /Select Twilight Imperium 4/i,
    });
    await user.click(item);

    // Configuration screen shows edition and content.
    await screen.findByRole('heading', { name: /Twilight Imperium 4/i });
    const checkbox = await screen.findByLabelText(/Prophecy of Kings/i);
    await user.click(checkbox);

    // Start the session.
    await user.click(screen.getByRole('button', { name: /Start session/i }));

    // Success screen.
    await screen.findByRole('heading', { name: /Session started/i });
    expect(captured.sessionCalls).toHaveLength(1);
    expect(captured.sessionCalls[0]).toEqual({
      gameId: 'g_ti4',
      editionId: 'e_1',
      enabledContentIds: ['c_pok'],
    });
  });

  it('opens the Add Game screen', async () => {
    stubFetch({
      'GET /games': () => ({ body: { items: [] } }),
      'POST /games': (init) => {
        const created: Game = {
          gameId: 'g_new',
          slug: 'new-game',
          name: 'New Game',
          editions: [],
          createdAt: now,
          updatedAt: now,
        };
        void init;
        return { status: 201, body: created };
      },
      'GET /games/g_new': () => ({
        body: {
          gameId: 'g_new',
          slug: 'new-game',
          name: 'New Game',
          editions: [],
          content: [],
          createdAt: now,
          updatedAt: now,
        } satisfies GameWithContent,
      }),
    });
    const user = userEvent.setup();
    render(<App apiUrl="https://api.test" />);
    await user.click(await screen.findByRole('button', { name: /Can.?t find your game/ }));
    const addForm = await screen.findByRole('heading', { name: /Add a game/i });
    expect(addForm).toBeInTheDocument();
    await user.type(screen.getByLabelText(/^Name$/i), 'New Game');
    await user.click(screen.getByRole('button', { name: /Create game/i }));
    // Now on configuration.
    await waitFor(() =>
      expect(within(document.body).getByRole('heading', { name: /New Game/i })).toBeInTheDocument(),
    );
  });
});
