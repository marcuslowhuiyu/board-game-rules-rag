import { useMemo, useState } from 'react';
import { createApiClient, type SessionView } from './api/client.js';
import { GameSearchScreen } from './screens/GameSearchScreen.js';
import { GameConfigurationScreen } from './screens/GameConfigurationScreen.js';
import { AddGameScreen } from './screens/AddGameScreen.js';
import { SettingsScreen } from './screens/SettingsScreen.js';
import { RulesChatScreen } from './screens/RulesChatScreen.js';
import { SourcesScreen } from './screens/SourcesScreen.js';

type Screen =
  | { kind: 'search' }
  | { kind: 'configure'; gameId: string }
  | { kind: 'sources'; gameId: string }
  | { kind: 'add' }
  | { kind: 'settings' }
  | { kind: 'chat'; session: SessionView; gameName: string };

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
        <button className="button" type="button" onClick={() => setScreen({ kind: 'settings' })}>
          Settings
        </button>
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
            onSessionStarted={(session, gameName) => setScreen({ kind: 'chat', session, gameName })}
          />
        )}
        {screen.kind === 'sources' && (
          <SourcesScreen
            api={api}
            gameId={screen.gameId}
            onBack={() => setScreen({ kind: 'configure', gameId: screen.gameId })}
          />
        )}
        {screen.kind === 'settings' && (
          <SettingsScreen api={api} onBack={() => setScreen({ kind: 'search' })} />
        )}
        {screen.kind === 'add' && (
          <AddGameScreen
            api={api}
            onCancel={() => setScreen({ kind: 'search' })}
            onCreated={(g) => setScreen({ kind: 'configure', gameId: g.gameId })}
          />
        )}
        {screen.kind === 'chat' && (
          <RulesChatScreen
            api={api}
            session={screen.session}
            gameName={screen.gameName}
            onExit={() => setScreen({ kind: 'search' })}
          />
        )}
      </main>
    </div>
  );
};
