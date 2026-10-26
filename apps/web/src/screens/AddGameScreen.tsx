import { useState } from 'react';
import type { ApiClient, Game } from '../api/client.js';

interface Props {
  api: ApiClient;
  onCancel: () => void;
  onCreated: (game: Game) => void;
}

export const AddGameScreen = ({ api, onCancel, onCreated }: Props): JSX.Element => {
  const [name, setName] = useState('');
  const [publisher, setPublisher] = useState('');
  const [editionName, setEditionName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const game = await api.createGame({
        name: name.trim(),
        ...(publisher.trim() ? { publisher: publisher.trim() } : {}),
        ...(editionName.trim() ? { initialEdition: { name: editionName.trim() } } : {}),
      });
      onCreated(game);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="screen" aria-labelledby="add-title">
      <button className="button" type="button" onClick={onCancel}>
        ← Back
      </button>
      <h2 id="add-title">Add a game</h2>
      <p className="notice">
        Registers metadata only. After the game is created, use the "Manage sources" button on the
        configuration screen to upload a PDF or paste a rules URL.
      </p>
      <form className="stack" onSubmit={submit}>
        <div className="field">
          <label htmlFor="game-name">Name</label>
          <input
            id="game-name"
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="game-publisher">Publisher (optional)</label>
          <input
            id="game-publisher"
            className="input"
            value={publisher}
            onChange={(e) => setPublisher(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="edition-name">Initial edition (optional)</label>
          <input
            id="edition-name"
            className="input"
            value={editionName}
            onChange={(e) => setEditionName(e.target.value)}
          />
        </div>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <button className="button primary" type="submit" disabled={busy || !name.trim()}>
          {busy ? 'Creating…' : 'Create game'}
        </button>
      </form>
    </section>
  );
};
