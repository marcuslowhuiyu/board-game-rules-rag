import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ApiClient, Game } from '../api/client.js';
import { GameSearchScreen } from './GameSearchScreen.js';

const now = '2026-11-24T00:00:00.000Z';
const game = (slug: string, name: string): Game => ({
  gameId: `g_${slug}`,
  slug,
  name,
  editions: [],
  createdAt: now,
  updatedAt: now,
});

describe('GameSearchScreen', () => {
  it('shows real games and hides test fixture games', async () => {
    const api = {
      listGames: vi.fn().mockResolvedValue({
        items: [game('wingspan', 'Wingspan'), game('wingspan-eval', 'Wingspan (eval)')],
      }),
    } as unknown as ApiClient;
    render(<GameSearchScreen api={api} onSelectGame={vi.fn()} onAddGame={vi.fn()} />);
    expect(await screen.findByLabelText('Select Wingspan')).toBeTruthy();
    expect(screen.queryByLabelText('Select Wingspan (eval)')).toBeNull();
  });
});
