import type { IngestionSourceRef } from '@bgr/domain';
import { assertUrlSafeForFetch, type SsrfGuardOptions } from '../ssrf.js';
import type { DocumentFetcher, FetchedSource } from './fetcher.js';

export interface UrlFetcherOptions extends SsrfGuardOptions {
  /** Wall-clock timeout per request. Default 20s. */
  timeoutMs?: number;
  /** Cap on response size in bytes. Default 25 MiB. */
  maxBytes?: number;
  /** Injectable fetch for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const DEFAULTS = { timeoutMs: 20_000, maxBytes: 25 * 1024 * 1024 } as const;

/**
 * URL-based document fetcher with an SSRF guard. Refuses to fetch until the
 * URL clears `assertUrlSafeForFetch` (MASTER_PLAN §17, §48). Rejects
 * responses whose declared or observed size exceeds `maxBytes`.
 */
export function createUrlFetcher(options: UrlFetcherOptions = {}): DocumentFetcher {
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const maxBytes = options.maxBytes ?? DEFAULTS.maxBytes;
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    async fetch(source: IngestionSourceRef): Promise<FetchedSource> {
      if (source.kind !== 'URL') {
        throw new Error(`URL fetcher cannot handle source of kind ${source.kind}`);
      }
      const url = await assertUrlSafeForFetch(source.url, options);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(url.toString(), {
          method: 'GET',
          signal: controller.signal,
          redirect: 'follow',
          headers: {
            accept: 'text/html,application/xhtml+xml,application/pdf,*/*;q=0.5',
            'user-agent': 'BgrRulesIngestion/1.0 (+https://bgr.example)',
          },
        });
        if (!res.ok) {
          throw new Error(`fetch failed: ${res.status} ${res.statusText}`);
        }
        const declared = Number(res.headers.get('content-length') ?? '0');
        if (declared > maxBytes) {
          throw new Error(`response too large: ${declared} > ${maxBytes}`);
        }
        const buf = new Uint8Array(await res.arrayBuffer());
        if (buf.byteLength > maxBytes) {
          throw new Error(`response too large: ${buf.byteLength} > ${maxBytes}`);
        }
        return {
          bytes: buf,
          contentType: res.headers.get('content-type') ?? 'application/octet-stream',
          canonicalUrl: url.toString(),
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
