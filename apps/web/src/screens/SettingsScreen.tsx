import { useEffect, useState } from 'react';
import {
  ApiError,
  type ApiClient,
  type ModelOptionView,
  type ModelRole,
  type ModelSettingsView,
} from '../api/client.js';

interface Props {
  api: ApiClient;
  onBack: () => void;
}

const LABELS: Record<ModelRole, string> = {
  router: 'Router',
  reranker: 'Reranker',
  answerer: 'Answerer',
};

const usd = (n: number): string => `$${n}`;

const optionText = (o: ModelOptionView): string =>
  `${o.displayName} — ${usd(o.inputUsdPerMTok)} in / ${usd(o.outputUsdPerMTok)} out per 1M tokens`;

export const SettingsScreen = ({ api, onBack }: Props): JSX.Element => {
  const [settings, setSettings] = useState<ModelSettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState<ModelRole | null>(null);

  useEffect(() => {
    let live = true;
    api
      .getModelSettings()
      .then((s) => live && setSettings(s))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [api]);

  const choose = async (role: ModelRole, key: string): Promise<void> => {
    setError(null);
    setSaved(false);
    setSaving(role);
    try {
      setSettings(await api.setModelChoice(role, key));
      setSaved(true);
    } catch (e) {
      // The select is controlled by the last saved settings, so it reverts on its own.
      setError(e instanceof ApiError || e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(null);
    }
  };

  return (
    <section className="screen" aria-labelledby="settings-title">
      <h2 id="settings-title">Settings</h2>
      <p className="notice">Settings are open to anyone with the link in dev.</p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {saved && (
        <p className="success" role="status">
          Saved. New questions use it within about a minute.
        </p>
      )}
      {settings?.roles.map((r) => (
        <div key={r.role} className="field">
          <label htmlFor={`model-${r.role}`}>{LABELS[r.role]}</label>
          <select
            id={`model-${r.role}`}
            className="select"
            value={r.chosen}
            disabled={saving !== null}
            onChange={(e) => void choose(r.role, e.target.value)}
          >
            {r.options.map((o) => (
              <option key={o.key} value={o.key}>
                {optionText(o)}
              </option>
            ))}
          </select>
        </div>
      ))}
      <button className="button" type="button" onClick={onBack}>
        Back to games
      </button>
    </section>
  );
};
