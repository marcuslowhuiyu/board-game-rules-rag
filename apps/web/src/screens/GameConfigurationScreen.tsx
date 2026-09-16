import { useEffect, useMemo, useState } from 'react';
import type { ApiClient, GameWithContent, SessionView } from '../api/client.js';

interface Props {
  api: ApiClient;
  gameId: string;
  onBack: () => void;
  onSessionStarted: (session: SessionView) => void;
}

export const GameConfigurationScreen = ({
  api,
  gameId,
  onBack,
  onSessionStarted,
}: Props): JSX.Element => {
  const [game, setGame] = useState<GameWithContent | null>(null);
  const [editionId, setEditionId] = useState<string | null>(null);
  const [enabled, setEnabled] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api
      .getGame(gameId)
      .then((res) => {
        if (cancelled) return;
        setGame(res);
        setEditionId(res.editions[0]?.editionId ?? null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'unknown error');
      });
    return () => {
      cancelled = true;
    };
  }, [api, gameId]);

  const contentForEdition = useMemo(() => {
    if (!game || !editionId) return [];
    return game.content.filter((c) => c.editionId === editionId);
  }, [game, editionId]);

  const startSession = async (): Promise<void> => {
    if (!game || !editionId) return;
    setBusy(true);
    setError(null);
    try {
      const session = await api.createSession({
        gameId: game.gameId,
        editionId,
        enabledContentIds: Object.entries(enabled)
          .filter(([, v]) => v)
          .map(([k]) => k),
      });
      onSessionStarted(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown error');
    } finally {
      setBusy(false);
    }
  };

  if (error)
    return (
      <div className="error" role="alert">
        {error}
      </div>
    );
  if (!game) return <p className="empty">Loading…</p>;

  return (
    <section className="screen" aria-labelledby="config-title">
      <button className="button" type="button" onClick={onBack} aria-label="Back">
        ← Back
      </button>
      <h2 id="config-title">{game.name}</h2>
      {game.publisher && <p className="meta">{game.publisher}</p>}

      <div className="field">
        <label htmlFor="edition-select">Edition</label>
        <select
          id="edition-select"
          className="select"
          value={editionId ?? ''}
          onChange={(e) => {
            setEditionId(e.target.value || null);
            setEnabled({});
          }}
        >
          {game.editions.length === 0 ? (
            <option value="" disabled>
              No editions
            </option>
          ) : (
            game.editions.map((e) => (
              <option key={e.editionId} value={e.editionId}>
                {e.name}
              </option>
            ))
          )}
        </select>
      </div>

      <h3>Expansions, promos &amp; modules</h3>
      {contentForEdition.length === 0 ? (
        <p className="empty">No optional content yet.</p>
      ) : (
        <ul className="list" aria-label="Optional content">
          {contentForEdition.map((c) => (
            <li key={c.contentId} className="check-row">
              <input
                id={`content-${c.contentId}`}
                type="checkbox"
                checked={!!enabled[c.contentId]}
                onChange={(e) =>
                  setEnabled((prev) => ({ ...prev, [c.contentId]: e.target.checked }))
                }
              />
              <label htmlFor={`content-${c.contentId}`}>
                <span className="name">{c.name}</span> <span className="pill">{c.contentType}</span>
              </label>
            </li>
          ))}
        </ul>
      )}

      <button
        className="button primary"
        type="button"
        onClick={startSession}
        disabled={!editionId || busy}
      >
        {busy ? 'Starting…' : 'Start session'}
      </button>
    </section>
  );
};
