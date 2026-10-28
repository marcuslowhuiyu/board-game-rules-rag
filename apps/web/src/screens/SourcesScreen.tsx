import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ApiClient,
  Authority,
  ContentPackage,
  GameWithContent,
  IngestionJobView,
  SourceType,
} from '../api/client.js';

interface Props {
  api: ApiClient;
  gameId: string;
  onBack: () => void;
}

const SOURCE_TYPE_OPTIONS: SourceType[] = [
  'RULEBOOK',
  'RULES_REFERENCE',
  'LIVING_RULES',
  'FAQ',
  'ERRATA',
  'PROMO_RULES',
  'DESIGNER_RULING',
  'PUBLISHER_RULING',
  'OTHER',
];

const AUTHORITY_OPTIONS: { value: Authority; label: string }[] = [
  { value: 'OFFICIAL_RULES', label: 'Official rules (publisher rulebook or reference)' },
  { value: 'OFFICIAL_ERRATA', label: 'Official errata or FAQ (from the publisher)' },
  { value: 'DESIGNER_OR_PUBLISHER', label: 'Designer or publisher ruling' },
  { value: 'COMMUNITY_CONSENSUS', label: 'Community consensus' },
  { value: 'COMMUNITY_DISCUSSION', label: 'Community discussion' },
  { value: 'UNKNOWN', label: 'Unknown' },
];

export const SourcesScreen = ({ api, gameId, onBack }: Props): JSX.Element => {
  const [game, setGame] = useState<GameWithContent | null>(null);
  const [editionId, setEditionId] = useState<string>('');
  const [contentId, setContentId] = useState<string>('');
  const [title, setTitle] = useState('');
  const [sourceType, setSourceType] = useState<SourceType>('RULEBOOK');
  const [authority, setAuthority] = useState<Authority | ''>('');
  const [urlValue, setUrlValue] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [job, setJob] = useState<IngestionJobView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Bumped whenever a new job starts or the screen unmounts; a poll loop
  // whose generation is stale stops and ignores any in-flight response.
  const pollGeneration = useRef(0);

  useEffect(() => {
    let cancelled = false;
    api
      .getGame(gameId)
      .then((res) => {
        if (cancelled) return;
        setGame(res);
        const firstEd = res.editions[0]?.editionId ?? '';
        setEditionId(firstEd);
        const firstContent = res.content.find((c) => c.editionId === firstEd);
        setContentId(firstContent?.contentId ?? '');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'unknown error');
      });
    return () => {
      cancelled = true;
      pollGeneration.current += 1;
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [api, gameId]);

  const contentForEdition = useMemo<ContentPackage[]>(() => {
    if (!game) return [];
    return game.content.filter((c) => c.editionId === editionId);
  }, [game, editionId]);

  const pollJob = useCallback(
    async (jobId: string, generation: number) => {
      try {
        const fresh = await api.getIngestion(jobId);
        if (generation !== pollGeneration.current) return;
        setJob(fresh);
        if (fresh.status === 'RUNNING' || fresh.status === 'PENDING') {
          pollRef.current = setTimeout(() => void pollJob(jobId, generation), 2000);
        }
      } catch (err) {
        if (generation !== pollGeneration.current) return;
        setError(err instanceof Error ? err.message : 'poll failed');
      }
    },
    [api],
  );

  /** Show a newly created job and poll it, abandoning any previous job's loop. */
  const trackJob = (created: IngestionJobView): void => {
    pollGeneration.current += 1;
    if (pollRef.current) clearTimeout(pollRef.current);
    setJob(created);
    void pollJob(created.jobId, pollGeneration.current);
  };

  const selectEdition = (nextEditionId: string): void => {
    setEditionId(nextEditionId);
    const first = game?.content.find((c) => c.editionId === nextEditionId);
    setContentId(first?.contentId ?? '');
  };

  const startFile = async (): Promise<void> => {
    if (!file || !authority || !editionId || !contentId || !title.trim()) return;
    setError(null);
    setBusy(true);
    try {
      const presign = await api.presignUpload({
        filename: file.name,
        contentType: file.type || 'application/pdf',
        sizeBytes: file.size,
      });
      await api.uploadFile(presign, file);
      const created = await api.createIngestion({
        gameId,
        editionId,
        contentId,
        title: title.trim(),
        sourceType,
        authority,
        source: {
          kind: 'S3',
          s3Key: presign.key,
          contentType: presign.contentType,
          filename: file.name,
          sizeBytes: file.size,
        },
      });
      trackJob(created);
      setAuthority('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ingestion failed');
    } finally {
      setBusy(false);
    }
  };

  const startUrl = async (): Promise<void> => {
    if (!urlValue.trim() || !authority || !editionId || !contentId || !title.trim()) return;
    setError(null);
    setBusy(true);
    try {
      const created = await api.createIngestion({
        gameId,
        editionId,
        contentId,
        title: title.trim(),
        sourceType,
        authority,
        source: { kind: 'URL', url: urlValue.trim() },
      });
      trackJob(created);
      setAuthority('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ingestion failed');
    } finally {
      setBusy(false);
    }
  };

  if (!game && !error) return <p className="empty">Loading…</p>;
  if (!game)
    return (
      <div className="error" role="alert">
        {error}
      </div>
    );

  return (
    <section className="screen" aria-labelledby="sources-title">
      <button className="button" type="button" onClick={onBack} aria-label="Back">
        ← Back
      </button>
      <h2 id="sources-title">Sources for {game.name}</h2>

      <div className="field">
        <label htmlFor="src-edition">Edition</label>
        <select
          id="src-edition"
          className="select"
          value={editionId}
          onChange={(e) => selectEdition(e.target.value)}
        >
          {game.editions.map((e) => (
            <option key={e.editionId} value={e.editionId}>
              {e.name} — rev {e.knowledgeRevision}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor="src-content">Content package</label>
        <select
          id="src-content"
          className="select"
          value={contentId}
          onChange={(e) => setContentId(e.target.value)}
        >
          {contentForEdition.length === 0 ? (
            <option value="" disabled>
              No content — seed one first
            </option>
          ) : (
            contentForEdition.map((c) => (
              <option key={c.contentId} value={c.contentId}>
                {c.name} ({c.contentType})
              </option>
            ))
          )}
        </select>
      </div>

      <div className="field">
        <label htmlFor="src-title">Title</label>
        <input
          id="src-title"
          className="input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Base Rulebook, 4th Edition"
          required
        />
      </div>

      <div className="field">
        <label htmlFor="src-type">Source type</label>
        <select
          id="src-type"
          className="select"
          value={sourceType}
          onChange={(e) => setSourceType(e.target.value as SourceType)}
        >
          {SOURCE_TYPE_OPTIONS.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor="src-authority">Trust tier</label>
        <select
          id="src-authority"
          className="select"
          value={authority}
          aria-describedby="src-authority-help"
          onChange={(e) => setAuthority(e.target.value as Authority)}
        >
          <option value="" disabled>
            Choose how official this source is…
          </option>
          {AUTHORITY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <p id="src-authority-help" className="meta">
          Pick "official" only if this file or page comes from the publisher. A FAQ written by
          players is community discussion.
        </p>
      </div>

      <fieldset className="stack">
        <legend>Upload PDF</legend>
        <input
          type="file"
          accept="application/pdf"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        <button
          className="button primary"
          type="button"
          disabled={busy || !file || !authority || !contentId || !title.trim()}
          onClick={() => void startFile()}
        >
          {busy ? 'Uploading…' : 'Upload & ingest PDF'}
        </button>
      </fieldset>

      <fieldset className="stack">
        <legend>…or paste a rules URL</legend>
        <input
          className="input"
          value={urlValue}
          onChange={(e) => setUrlValue(e.target.value)}
          placeholder="https://publisher.example.com/living-rules"
        />
        <button
          className="button"
          type="button"
          disabled={busy || !urlValue.trim() || !authority || !contentId || !title.trim()}
          onClick={() => void startUrl()}
        >
          {busy ? 'Starting…' : 'Ingest URL'}
        </button>
      </fieldset>

      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}

      {job && (
        <section className="stack" aria-live="polite">
          <h3>Job {job.jobId}</h3>
          <p className="meta">
            <strong>Status:</strong> {job.status} · <strong>Stage:</strong> {job.stage}
          </p>
          <p className="meta">
            Completed: {job.completedStages.length === 0 ? 'none' : job.completedStages.join(' → ')}
          </p>
          {job.duplicateOf && (
            <p className="notice">
              Duplicate of document <code>{job.duplicateOf}</code>. No new chunks were created.
            </p>
          )}
          {job.status === 'SUCCEEDED' && job.chunkCount !== undefined && (
            <p className="notice">
              Ingested {job.chunkCount} chunks. Document id: <code>{job.documentId}</code>.
            </p>
          )}
          {job.error && (
            <div className="error" role="alert">
              Failed at <strong>{job.error.stage}</strong>: {job.error.message}
            </div>
          )}
        </section>
      )}
    </section>
  );
};
