import { describe, expect, it } from 'vitest';
import { SsrfError, assertUrlSafeForFetch, isDisallowedIp } from './ssrf.js';

describe('isDisallowedIp', () => {
  it.each([
    '127.0.0.1',
    '127.5.5.5',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.1',
    '169.254.169.254',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'ff02::1',
    '::ffff:10.0.0.1',
  ])('flags %s', (ip) => {
    expect(isDisallowedIp(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '54.239.28.85', '2606:4700:4700::1111'])('allows %s', (ip) => {
    expect(isDisallowedIp(ip)).toBe(false);
  });
});

describe('assertUrlSafeForFetch', () => {
  const publicResolver = async () => [{ address: '8.8.8.8' }];

  it('rejects non-http protocols', async () => {
    await expect(
      assertUrlSafeForFetch('file:///etc/passwd', { resolveDns: publicResolver }),
    ).rejects.toThrow(SsrfError);
  });

  it('rejects literal loopback', async () => {
    await expect(
      assertUrlSafeForFetch('http://127.0.0.1/x', { resolveDns: publicResolver }),
    ).rejects.toMatchObject({ code: 'DISALLOWED_IP' });
  });

  it('rejects literal EC2 metadata', async () => {
    await expect(
      assertUrlSafeForFetch('http://169.254.169.254/latest/', { resolveDns: publicResolver }),
    ).rejects.toMatchObject({ code: 'DISALLOWED_IP' });
  });

  it('rejects localhost hostname', async () => {
    await expect(
      assertUrlSafeForFetch('http://localhost:8080/', { resolveDns: publicResolver }),
    ).rejects.toMatchObject({ code: 'DISALLOWED_HOST' });
  });

  it('rejects .internal / .local suffixes', async () => {
    await expect(
      assertUrlSafeForFetch('http://kube.internal/api', { resolveDns: publicResolver }),
    ).rejects.toMatchObject({ code: 'DISALLOWED_SUFFIX' });
  });

  it('rejects hostnames that resolve to private IPs', async () => {
    await expect(
      assertUrlSafeForFetch('http://sneaky.example.com/', {
        resolveDns: async () => [{ address: '10.0.0.5' }],
      }),
    ).rejects.toMatchObject({ code: 'DISALLOWED_RESOLVED_IP' });
  });

  it('accepts a public https URL', async () => {
    const url = await assertUrlSafeForFetch('https://publisher.example.com/rules', {
      resolveDns: publicResolver,
    });
    expect(url.hostname).toBe('publisher.example.com');
  });

  it('rejects invalid URLs', async () => {
    await expect(assertUrlSafeForFetch('not a url')).rejects.toMatchObject({
      code: 'INVALID_URL',
    });
  });
});
