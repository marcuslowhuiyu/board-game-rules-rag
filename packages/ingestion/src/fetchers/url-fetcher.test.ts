import { describe, expect, it } from 'vitest';
import { createUrlFetcher } from './url-fetcher.js';
import { SsrfError } from '../ssrf.js';

const publicResolver = async () => [{ address: '8.8.8.8' }];

function makeResponse(init: {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}): Response {
  const headers = new Headers({ 'content-type': 'text/html', ...(init.headers ?? {}) });
  return new Response(init.body ?? '', { status: init.status, headers });
}

describe('createUrlFetcher redirect handling', () => {
  it('follows a safe public redirect and returns final canonical URL', async () => {
    const calls: string[] = [];
    const fetcher = createUrlFetcher({
      resolveDns: publicResolver,
      fetchImpl: async (url) => {
        calls.push(String(url));
        if (String(url) === 'https://a.example.com/x') {
          return makeResponse({
            status: 302,
            headers: { location: 'https://b.example.com/y' },
          });
        }
        return makeResponse({ status: 200, body: '<html><body>ok</body></html>' });
      },
    });
    const result = await fetcher.fetch({ kind: 'URL', url: 'https://a.example.com/x' });
    expect(calls).toEqual(['https://a.example.com/x', 'https://b.example.com/y']);
    expect(result.canonicalUrl).toBe('https://b.example.com/y');
  });

  it('rejects when a public URL redirects to a private IP', async () => {
    let step = 0;
    const fetcher = createUrlFetcher({
      resolveDns: async () => {
        step += 1;
        // First hop hostname resolves to a public IP; second hop is a literal
        // private IP (so DNS is not consulted).
        return step === 1 ? [{ address: '8.8.8.8' }] : [{ address: '10.0.0.1' }];
      },
      fetchImpl: async () =>
        makeResponse({ status: 302, headers: { location: 'http://10.0.0.1/private' } }),
    });
    await expect(
      fetcher.fetch({ kind: 'URL', url: 'https://public.example.com/redirect' }),
    ).rejects.toBeInstanceOf(SsrfError);
  });

  it('rejects when the SECOND hop is a hostname that resolves to a private IP', async () => {
    let step = 0;
    const fetcher = createUrlFetcher({
      resolveDns: async () => {
        step += 1;
        return step === 1 ? [{ address: '8.8.8.8' }] : [{ address: '169.254.169.254' }];
      },
      fetchImpl: async () =>
        makeResponse({ status: 302, headers: { location: 'https://sneaky.example/x' } }),
    });
    await expect(
      fetcher.fetch({ kind: 'URL', url: 'https://ok.example/first' }),
    ).rejects.toMatchObject({ code: 'DISALLOWED_RESOLVED_IP' });
  });

  it('caps the redirect chain', async () => {
    const fetcher = createUrlFetcher({
      resolveDns: publicResolver,
      maxRedirects: 2,
      fetchImpl: async (url) =>
        makeResponse({
          status: 302,
          headers: {
            location: String(url).replace(/hop\d*/, (m) => 'hop' + (parseInt(m.slice(3)) + 1 || 1)),
          },
        }),
    });
    await expect(
      fetcher.fetch({ kind: 'URL', url: 'https://loop.example/hop1' }),
    ).rejects.toMatchObject({ code: 'TOO_MANY_REDIRECTS' });
  });

  it('detects a redirect loop back to a previously visited URL', async () => {
    const fetcher = createUrlFetcher({
      resolveDns: publicResolver,
      fetchImpl: async (url) => {
        const u = String(url);
        if (u === 'https://a.example/1') {
          return makeResponse({ status: 302, headers: { location: 'https://a.example/2' } });
        }
        return makeResponse({ status: 302, headers: { location: 'https://a.example/1' } });
      },
    });
    await expect(fetcher.fetch({ kind: 'URL', url: 'https://a.example/1' })).rejects.toMatchObject({
      code: 'REDIRECT_LOOP',
    });
  });
});

describe('createUrlFetcher size limit', () => {
  /** A body with no Content-Length, produced lazily 100 bytes per pull. */
  function lazyBody(totalChunks: number) {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= totalChunks) return controller.close();
        pulled += 1;
        controller.enqueue(new Uint8Array(100));
      },
    });
    return { stream, pulled: () => pulled };
  }

  it('aborts a body without Content-Length as soon as it exceeds maxBytes', async () => {
    const body = lazyBody(1000); // 100 KB on offer; limit is 1 KB
    const fetcher = createUrlFetcher({
      resolveDns: publicResolver,
      maxBytes: 1000,
      fetchImpl: async () =>
        new Response(body.stream, { status: 200, headers: { 'content-type': 'text/html' } }),
    });
    await expect(fetcher.fetch({ kind: 'URL', url: 'https://a.example.com/big' })).rejects.toThrow(
      /too large/,
    );
    // Stopped just past the limit instead of buffering all 1000 chunks.
    expect(body.pulled()).toBeLessThanOrEqual(12);
  });

  it('returns a body under maxBytes intact', async () => {
    const body = lazyBody(5);
    const fetcher = createUrlFetcher({
      resolveDns: publicResolver,
      maxBytes: 1000,
      fetchImpl: async () =>
        new Response(body.stream, { status: 200, headers: { 'content-type': 'text/html' } }),
    });
    const result = await fetcher.fetch({ kind: 'URL', url: 'https://a.example.com/small' });
    expect(result.bytes.byteLength).toBe(500);
  });
});
