import { useMemo, useState } from 'react';
import { createApiClient, type SessionView } from './api/client.js';
import { GameSearchScreen } from './screens/GameSearchScreen.js';
import { GameConfigurationScreen } from './screens/GameConfigurationScreen.js';
import { AddGameScreen } from './screens/AddGameScreen.js';
import { SourcesScreen } from './screens/SourcesScreen.js';

type Screen =
  | { kind: 'search' }
  | { kind: 'configure'; gameId: string }
  | { kind: 'sources'; gameId: string }
  | { kind: 'add' }
  | { kind: 'started'; session: SessionView };

const defaultApiUrl = (): string => {
  // In prod CloudFront serves the SPA at `/` and forwards `/api/*` to API
  // Gateway, so a same-origin relative base is correct. Local dev can point
  // at a full URL via VITE_API_URL — but the browser will only send the
  // session cookie when the API is same-origin, so local dev flows that
  // depend on the cookie should also proxy through the Vite dev server.
  const url = (typeof import.meta.env !== 'undefined' && import.meta.env['VITE_API_URL']) as
    string | undefined;
  return url ?? '/api';
};

export const App = ({ apiUrl }: { apiUrl?: string } = {}): JSX.Element => {
  const [screen, setScreen] = useState<Screen>({ kind: 'search' });
  const api = useMemo(() => createApiClient(apiUrl ?? defaultApiUrl()), [apiUrl]);

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>Board Game Rules Referee</h1>
        <p className="subtitle">Milestone 1 — game catalog &amp; anonymous sessions</p>
      </header>
      <main>
        {screen.kind === 'search' && (
          <GameSearchScreen
            api={api}
            onSelectGame={(gameId) => setScreen({ kind: 'configure', gameId })}
            onAddGame={() => setScreen({ kind: 'add' })}
          />
        )}
        {screen.kind === 'configure' && (
          <GameConfigurationScreen
            api={api}
            gameId={screen.gameId}
            onBack={() => setScreen({ kind: 'search' })}
            onManageSources={() => setScreen({ kind: 'sources', gameId: screen.gameId })}
            onSessionStarted={(session) => setScreen({ kind: 'started', session })}
          />
        )}
        {screen.kind === 'sources' && (
          <SourcesScreen
            api={api}
            gameId={screen.gameId}
            onBack={() => setScreen({ kind: 'configure', gameId: screen.gameId })}
          />
        )}
        {screen.kind === 'add' && (
          <AddGameScreen
            api={api}
            onCancel={() => setScreen({ kind: 'search' })}
            onCreated={(g) => setScreen({ kind: 'configure', gameId: g.gameId })}
          />
        )}
        {screen.kind === 'started' && (
          <section className="screen" aria-labelledby="started-title">
            <h2 id="started-title">Session started</h2>
            <p className="notice">Anonymous session is live. A chat UI arrives in Milestone 4.</p>
            <ul className="list">
              <li className="list-item">
                <span className="meta">Session id</span>
                <span className="name" style={{ wordBreak: 'break-all' }}>
                  {screen.session.sessionId}
                </span>
              </li>
              <li className="list-item">
                <span className="meta">Expires</span>
                <span className="name">{new Date(screen.session.expiresAt).toLocaleString()}</span>
              </li>
            </ul>
            <button className="button" type="button" onClick={() => setScreen({ kind: 'search' })}>
              Back to games
            </button>
          </section>
        )}
      </main>
    </div>
  );
};
