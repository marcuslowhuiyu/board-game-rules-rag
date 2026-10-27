import { basename, extname } from 'node:path';
import { AuthoritySchema, SourceTypeSchema } from '@bgr/domain';
import { z } from 'zod';
import type { EvalGames } from '../run-eval.js';

const EvalDocumentSchema = z
  .object({
    title: z.string().min(1).max(300),
    sourceType: SourceTypeSchema,
    authority: AuthoritySchema,
    /** Path to a local file (kept outside the repo); `~` is expanded by the script. */
    local: z.string().min(1).optional(),
    url: z.string().url().optional(),
    /** A raw object already in the ingestion bucket (e.g. a rulebook ingested for an older game). */
    s3Key: z.string().min(1).optional(),
    /** Leave out of this run, e.g. a PDF the operator has not supplied yet. */
    skip: z.boolean().optional(),
  })
  .refine((d) => [d.local, d.url, d.s3Key].filter((x) => x !== undefined).length === 1, {
    message: 'exactly one of local, url or s3Key must be set',
  });

export const EvalSourcesSchema = z.record(
  z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  z.object({
    name: z.string().min(1).max(200),
    edition: z.string().min(1).max(200),
    documents: z.array(EvalDocumentSchema).min(1),
  }),
);
export type EvalSources = z.infer<typeof EvalSourcesSchema>;

/**
 * Within one content package, FINALIZE treats a new document as superseding
 * the CURRENT one with the same sourceType, which would silently drop it from
 * retrieval. Each eval game has a single base package, so types must differ.
 */
export function assertDistinctSourceTypes(sources: EvalSources): void {
  for (const [key, game] of Object.entries(sources)) {
    const seen = new Set<string>();
    for (const doc of game.documents) {
      if (seen.has(doc.sourceType)) {
        throw new Error(`game ${key} has two documents with sourceType ${doc.sourceType}`);
      }
      seen.add(doc.sourceType);
    }
  }
}

const CONTENT_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.html': 'text/html',
  '.htm': 'text/html',
};

interface Options {
  apiBase: string;
  sources: EvalSources;
  fetch: typeof fetch;
  readLocal: (path: string) => Promise<Uint8Array>;
  poll: { intervalMs: number; timeoutMs: number };
  log?: (line: string) => void;
}

/**
 * Creates (or reuses) one eval game per entry and ingests its documents
 * through the public API, waiting for each job. Re-running is safe: games
 * are matched by slug and identical uploads short-circuit as duplicates.
 */
export async function ingestEvalGames(opts: Options): Promise<EvalGames> {
  assertDistinctSourceTypes(opts.sources);
  const log = opts.log ?? (() => {});

  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await opts.fetch(`${opts.apiBase}${path}`, {
      method,
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
    return (text ? JSON.parse(text) : undefined) as T;
  };

  const out: EvalGames = {};
  for (const [key, spec] of Object.entries(opts.sources)) {
    const slug = `${key}-eval`;
    type GameView = { gameId: string; slug: string; editions: Array<{ editionId: string }> };
    const found = await call<{ items: GameView[] }>('GET', `/games?q=${slug}`);
    const game =
      found.items.find((g) => g.slug === slug) ??
      (await call<GameView>('POST', '/games', {
        name: spec.name,
        slug,
        initialEdition: { name: spec.edition },
      }));
    const editionId = game.editions[0]?.editionId;
    if (!editionId) throw new Error(`game ${slug} has no edition`);
    const content = await call<{
      items: Array<{ contentId: string; slug: string; editionId: string }>;
    }>('GET', `/games/${game.gameId}/content`);
    const base = content.items.find((c) => c.slug === 'base' && c.editionId === editionId);
    if (!base) throw new Error(`game ${slug} has no base content package`);
    log(`${spec.name}: game ${game.gameId}`);

    let chunks = 0;
    for (const doc of spec.documents) {
      if (doc.skip) {
        log(`  skipped: ${doc.title}`);
        continue;
      }
      let source: Record<string, unknown>;
      if (doc.local !== undefined) {
        const bytes = await opts.readLocal(doc.local);
        const contentType = CONTENT_TYPES[extname(doc.local).toLowerCase()];
        if (!contentType) throw new Error(`unsupported file type: ${doc.local}`);
        const filename = basename(doc.local);
        const presign = await call<{
          url: string;
          key: string;
          requiredHeaders: Record<string, string>;
        }>('POST', '/uploads/presign', { filename, contentType, sizeBytes: bytes.byteLength });
        const put = await opts.fetch(presign.url, {
          method: 'PUT',
          headers: presign.requiredHeaders,
          body: bytes,
        });
        if (!put.ok) throw new Error(`upload of ${doc.title} failed: ${put.status}`);
        source = {
          kind: 'S3',
          s3Key: presign.key,
          contentType,
          filename,
          sizeBytes: bytes.byteLength,
        };
      } else if (doc.s3Key !== undefined) {
        const contentType = CONTENT_TYPES[extname(doc.s3Key).toLowerCase()];
        if (!contentType) throw new Error(`unsupported file type: ${doc.s3Key}`);
        source = { kind: 'S3', s3Key: doc.s3Key, contentType, filename: basename(doc.s3Key) };
      } else {
        source = { kind: 'URL', url: doc.url };
      }

      const job = await call<{ jobId: string }>('POST', '/ingestion', {
        gameId: game.gameId,
        editionId,
        contentId: base.contentId,
        title: doc.title,
        sourceType: doc.sourceType,
        authority: doc.authority,
        source,
      });
      const documentId = await waitForJob(call, job.jobId, doc.title, opts.poll);
      const published = await call<{ chunkCount: number }>('GET', `/sources/${documentId}`);
      chunks += published.chunkCount;
      log(`  ${doc.title}: ${documentId} (${published.chunkCount} chunks)`);
    }
    out[key] = { gameId: game.gameId, editionId, content: { base: base.contentId }, chunks };
  }
  return out;
}

type JobView = {
  status: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  documentId?: string;
  duplicateOf?: string;
  error?: { stage: string; message: string };
};

async function waitForJob(
  call: <T>(method: string, path: string) => Promise<T>,
  jobId: string,
  title: string,
  poll: Options['poll'],
): Promise<string> {
  const deadline = Date.now() + poll.timeoutMs;
  for (;;) {
    const job = await call<JobView>('GET', `/ingestion/${jobId}`);
    if (job.status === 'FAILED') {
      throw new Error(
        `${title}: job ${jobId} FAILED at ${job.error?.stage ?? '?'}: ${job.error?.message ?? 'unknown error'}`,
      );
    }
    if (job.status === 'SUCCEEDED') {
      const documentId = job.documentId ?? job.duplicateOf;
      if (!documentId) throw new Error(`${title}: job ${jobId} succeeded without a document`);
      return documentId;
    }
    if (Date.now() > deadline) throw new Error(`${title}: job ${jobId} timed out (${job.status})`);
    await new Promise((r) => setTimeout(r, poll.intervalMs));
  }
}
