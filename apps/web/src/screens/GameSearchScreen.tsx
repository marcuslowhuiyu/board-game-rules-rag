import { useEffect, useState } from 'react';
import type { ApiClient, Game } from '../api/client.js';

interface Props {
  api: ApiClient;
  onSelectGame: (gameId: string) => void;
  onAddGame: () => void;
}

export const GameSearchScreen = ({ api, onSelectGame, onAddGame }: Props): JSX.Element => {
  const [query, setQuery] = useState('');
  const [games, setGames] = useState<Game[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .listGames(query || undefined)
      .then((res) => {
        if (cancelled) return;
        setGames(res.items);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'unknown error');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, query]);

  return (
    <section className="screen" aria-labelledby="search-title">
      <h2 id="search-title">Find a game</h2>
      <div className="field">
        <label htmlFor="search-input">Search</label>
        <input
          id="search-input"
          className="input"
          type="search"
          placeholder="Twilight Imperium…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}

      {loading ? (
        <p className="empty">Loading…</p>
      ) : games.length === 0 ? (
        <p className="empty">No games yet. Add one to get started.</p>
      ) : (
        <ul className="list">
          {games.map((g) => (
            <li
              key={g.gameId}
              className="list-item selectable"
              onClick={() => onSelectGame(g.gameId)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') onSelectGame(g.gameId);
              }}
              tabIndex={0}
              role="button"
              aria-label={`Select ${g.name}`}
            >
              <span className="name">{g.name}</span>
              <span className="meta">
                {g.publisher ? `${g.publisher} · ` : ''}
                {g.editions.length} edition{g.editions.length === 1 ? '' : 's'}
              </span>
            </li>
          ))}
        </ul>
      )}

      <button className="button" type="button" onClick={onAddGame}>
        Can’t find your game? Add it
      </button>
    </section>
  );
};
