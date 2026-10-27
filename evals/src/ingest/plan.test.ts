import { describe, expect, it } from 'vitest';
import { assertDistinctSourceTypes, ingestEvalGames, type EvalSources } from './plan.js';

const sources: EvalSources = {
  seti: {
    name: 'SETI (eval)',
    edition: 'Base',
    documents: [
      {
        title: 'SETI rulebook',
        sourceType: 'RULEBOOK',
        authority: 'OFFICIAL_RULES',
        local: '/books/seti.pdf',
      },
      {
        title: 'SETI FAQ',
        sourceType: 'FAQ',
        authority: 'OFFICIAL_ERRATA',
        url: 'https://example.com/faq',
      },
    ],
  },
};

interface Call {
  method: string;
  url: string;
  body?: unknown;
}

/** A fake API: answers by method + path, and records every call in order. */
function fakeApi(opts: { existingGame?: boolean; failJob?: boolean } = {}) {
  const calls: Call[] = [];
  let jobs = 0;
  const json = (status: number, data: unknown) =>
    new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  const game = {
    gameId: 'g_1',
    slug: 'seti-eval',
    editions: [{ editionId: 'e_1', name: 'Base' }],
  };
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, ...(body !== undefined ? { body } : {}) });
    const path = url.replace('https://api.test', '');
    if (method === 'GET' && path.startsWith('/games?q=')) {
      return json(200, { items: opts.existingGame ? [game] : [] });
    }
    if (method === 'POST' && path === '/games') return json(201, game);
    if (method === 'GET' && path === '/games/g_1/content') {
      return json(200, { items: [{ contentId: 'c_base', slug: 'base', editionId: 'e_1' }] });
    }
    if (method === 'POST' && path === '/uploads/presign') {
      return json(200, {
        url: 'https://s3.test/put',
        key: 'raw/abc.pdf',
        contentType: 'application/pdf',
        requiredHeaders: { 'content-type': 'application/pdf' },
      });
    }
    if (method === 'PUT' && url === 'https://s3.test/put')
      return new Response(null, { status: 200 });
    if (method === 'POST' && path === '/ingestion') {
      jobs++;
      return json(201, { jobId: `job_${jobs}`, status: 'PENDING' });
    }
    if (method === 'GET' && path.startsWith('/ingestion/job_')) {
      const id = path.split('/').pop()!;
      if (opts.failJob) {
        return json(200, {
          jobId: id,
          status: 'FAILED',
          error: { stage: 'PARSE', message: 'looks like a scan' },
        });
      }
      return json(200, { jobId: id, status: 'SUCCEEDED', documentId: `doc_${id}` });
    }
    if (method === 'GET' && path.startsWith('/sources/doc_')) {
      return json(200, { documentId: path.split('/').pop(), chunkCount: 40 });
    }
    return json(404, { error: { message: `unexpected ${method} ${path}` } });
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

const run = (api: ReturnType<typeof fakeApi>) =>
  ingestEvalGames({
    apiBase: 'https://api.test',
    sources,
    fetch: api.fetch,
    readLocal: async () => new Uint8Array([37, 80, 68, 70]),
    poll: { intervalMs: 0, timeoutMs: 1000 },
  });

describe('assertDistinctSourceTypes', () => {
  it('rejects two RULEBOOK docs in one game', () => {
    const dup: EvalSources = {
      seti: {
        ...sources['seti']!,
        documents: [
          sources['seti']!.documents[0]!,
          { ...sources['seti']!.documents[0]!, title: 'x' },
        ],
      },
    };
    expect(() => assertDistinctSourceTypes(dup)).toThrow(/seti.*RULEBOOK/);
  });
});

describe('ingestEvalGames', () => {
  it('creates the game, then uploads, ingests and polls each document', async () => {
    const api = fakeApi();
    const games = await run(api);
    const seq = api.calls.map((c) => `${c.method} ${c.url.replace('https://api.test', '')}`);
    expect(seq).toEqual([
      'GET /games?q=seti-eval',
      'POST /games',
      'GET /games/g_1/content',
      'POST /uploads/presign',
      'PUT https://s3.test/put',
      'POST /ingestion',
      'GET /ingestion/job_1',
      'GET /sources/doc_job_1',
      'POST /ingestion',
      'GET /ingestion/job_2',
      'GET /sources/doc_job_2',
    ]);
    const ingest = api.calls.filter((c) => c.url.endsWith('/ingestion'));
    expect(ingest[0]!.body).toMatchObject({
      gameId: 'g_1',
      editionId: 'e_1',
      contentId: 'c_base',
      sourceType: 'RULEBOOK',
      source: { kind: 'S3', s3Key: 'raw/abc.pdf', contentType: 'application/pdf' },
    });
    expect(ingest[1]!.body).toMatchObject({
      sourceType: 'FAQ',
      authority: 'OFFICIAL_ERRATA',
      source: { kind: 'URL', url: 'https://example.com/faq' },
    });
    expect(games).toEqual({
      seti: { gameId: 'g_1', editionId: 'e_1', content: { base: 'c_base' }, chunks: 80 },
    });
  });

  it('reuses an existing game by slug', async () => {
    const api = fakeApi({ existingGame: true });
    await run(api);
    expect(api.calls.some((c) => c.method === 'POST' && c.url.endsWith('/games'))).toBe(false);
  });

  it('skips documents marked skip', async () => {
    const api = fakeApi();
    const skipped: EvalSources = {
      seti: {
        ...sources['seti']!,
        documents: [
          sources['seti']!.documents[0]!,
          { ...sources['seti']!.documents[1]!, skip: true },
        ],
      },
    };
    await ingestEvalGames({
      apiBase: 'https://api.test',
      sources: skipped,
      fetch: api.fetch,
      readLocal: async () => new Uint8Array([1]),
      poll: { intervalMs: 0, timeoutMs: 1000 },
    });
    expect(api.calls.filter((c) => c.url.endsWith('/ingestion'))).toHaveLength(1);
  });

  it('a FAILED job throws with its stage and message', async () => {
    await expect(run(fakeApi({ failJob: true }))).rejects.toThrow(
      /SETI rulebook.*FAILED at PARSE: looks like a scan/,
    );
  });
});

describe('ingestEvalGames with an existing raw object', () => {
  it('ingests an S3 key already in the bucket without uploading', async () => {
    const api = fakeApi();
    await ingestEvalGames({
      apiBase: 'https://api.test',
      sources: {
        seti: {
          name: 'SETI (eval)',
          edition: 'Base',
          documents: [
            {
              title: 'SETI rulebook',
              sourceType: 'RULEBOOK',
              authority: 'OFFICIAL_RULES',
              s3Key: 'raw/upload/abc.pdf',
            },
          ],
        },
      },
      fetch: api.fetch,
      readLocal: async () => {
        throw new Error('must not read a local file');
      },
      poll: { intervalMs: 0, timeoutMs: 1000 },
    });
    expect(api.calls.some((c) => c.url.endsWith('/uploads/presign'))).toBe(false);
    const ingest = api.calls.find((c) => c.url.endsWith('/ingestion'));
    expect(ingest?.body).toMatchObject({
      source: { kind: 'S3', s3Key: 'raw/upload/abc.pdf', contentType: 'application/pdf' },
    });
  });
});
