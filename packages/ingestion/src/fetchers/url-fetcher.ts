import type { IngestionSourceRef } from '@bgr/domain';
import { assertUrlSafeForFetch, SsrfError, type SsrfGuardOptions } from '../ssrf.js';
import type { DocumentFetcher, FetchedSource } from './fetcher.js';

export interface UrlFetcherOptions extends SsrfGuardOptions {
  /** Wall-clock timeout for the whole redirect chain. Default 20 s. */
  timeoutMs?: number;
  /** Cap on response size in bytes. Default 25 MiB. */
  maxBytes?: number;
  /** Maximum redirects to follow. Default 5. */
  maxRedirects?: number;
  /** Injectable fetch for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const DEFAULTS = { timeoutMs: 20_000, maxBytes: 25 * 1024 * 1024, maxRedirects: 5 } as const;

/**
 * URL-based document fetcher.
 *
 * Redirect handling is deliberately MANUAL (`redirect: 'manual'` on every
 * hop). An initially safe public URL is not allowed to redirect to a
 * loopback / RFC1918 / link-local / EC2-metadata target — every Location
 * header is passed through `assertUrlSafeForFetch` before the next request
 * is issued. Bounded at `maxRedirects`; loops fail rather than hang.
 *
 * Residual risk — DNS rebinding: `assertUrlSafeForFetch` resolves the
 * hostname and re-checks the resolved IPs, but the subsequent connection
 * performs its own DNS lookup, which could in principle return a different
 * IP. Node's `fetch` (undici) does not currently accept a "pin to this
 * IP" hint; documented here and in ADR-0008 as accepted residual risk for
 * M2. Mitigating this fully requires a custom `undici.Agent` with a pinned
 * resolver, tracked as a follow-up.
 */
export function createUrlFetcher(options: UrlFetcherOptions = {}): DocumentFetcher {
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const maxBytes = options.maxBytes ?? DEFAULTS.maxBytes;
  const maxRedirects = options.maxRedirects ?? DEFAULTS.maxRedirects;
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async fetch(source: IngestionSourceRef): Promise<FetchedSource> {
      if (source.kind !== 'URL') {
        throw new Error(`URL fetcher cannot handle source of kind ${source.kind}`);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        let currentUrl = source.url;
        const seen = new Set<string>();
        for (let hop = 0; hop <= maxRedirects; hop++) {
          const safeUrl = await assertUrlSafeForFetch(currentUrl, options);
          const canonical = safeUrl.toString();
          if (seen.has(canonical)) {
            throw new SsrfError(`redirect loop detected at ${canonical}`, 'REDIRECT_LOOP');
          }
          seen.add(canonical);

          const res = await fetchImpl(canonical, {
            method: 'GET',
            signal: controller.signal,
            redirect: 'manual',
            headers: {
              accept: 'text/html,application/xhtml+xml,application/pdf,*/*;q=0.5',
              'user-agent': 'BgrRulesIngestion/1.0 (+https://bgr.example)',
            },
          });

          // 3xx → per-hop SSRF guard against the redirect target.
          if (res.status >= 300 && res.status < 400) {
            const location = res.headers.get('location');
            if (!location) {
              throw new Error(`redirect ${res.status} without Location header at ${canonical}`);
            }
            currentUrl = new URL(location, canonical).toString();
            continue;
          }

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
            canonicalUrl: canonical,
          };
        }
        throw new SsrfError(
          `exceeded ${maxRedirects} redirects starting from ${source.url}`,
          'TOO_MANY_REDIRECTS',
        );
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
