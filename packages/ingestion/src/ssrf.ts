import { isIP } from 'node:net';
import { promises as dns } from 'node:dns';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
const DISALLOWED_HOSTS = new Set([
  'localhost',
  'localhost.localdomain',
  '0.0.0.0',
  'broadcasthost',
]);

/**
 * Return true when the IP address is inside a range we refuse to fetch —
 * loopback, private, link-local, unique-local, multicast, cloud metadata.
 * See MASTER_PLAN §17 and §48.
 */
export function isDisallowedIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 0) return false;
  if (kind === 4) return isDisallowedIpv4(ip);
  return isDisallowedIpv6(ip);
}

function isDisallowedIpv4(ip: string): boolean {
  const octets = ip.split('.').map(Number);
  if (octets.length !== 4 || octets.some((o) => Number.isNaN(o))) return true;
  const [a, b] = octets as [number, number, number, number];
  if (a === 0) return true; // "this network"
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + EC2 metadata (169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 192 && b === 0) return true; // IETF reserved
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isDisallowedIpv6(raw: string): boolean {
  const ip = raw.toLowerCase().replace(/%.*$/, '');
  if (ip === '::' || ip === '::1') return true;
  if (ip.startsWith('fe80:')) return true; // link-local
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true; // unique local (fc00::/7)
  if (ip.startsWith('ff')) return true; // multicast
  if (ip.startsWith('::ffff:')) {
    // IPv4-mapped, dotted (`::ffff:127.0.0.1`) or hex (`::ffff:7f00:1` — the
    // form WHATWG URL normalises to).
    const v4 = ip.slice('::ffff:'.length);
    if (isIP(v4) === 4) return isDisallowedIpv4(v4);
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v4);
    if (hex) {
      const hi = parseInt(hex[1]!, 16);
      const lo = parseInt(hex[2]!, 16);
      return isDisallowedIpv4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
    }
  }
  return false;
}

export interface SsrfGuardOptions {
  /** Injectable DNS resolver for tests. Defaults to `dns.lookup` (returns all records). */
  resolveDns?: (hostname: string) => Promise<{ address: string }[]>;
  /** Override the allow-list of protocols. Defaults to http/https. */
  allowedProtocols?: Set<string>;
}

export class SsrfError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'SsrfError';
  }
}

/**
 * Validate a URL against SSRF policy. Rejects non-http(s) protocols, obvious
 * local hostnames, literal private/loopback IPs, and hostnames that resolve
 * to private/loopback IPs. Callers must invoke this before ever handing the
 * URL to `fetch()`.
 */
export async function assertUrlSafeForFetch(
  input: string,
  options: SsrfGuardOptions = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new SsrfError(`invalid URL: ${input}`, 'INVALID_URL');
  }
  const allowed = options.allowedProtocols ?? ALLOWED_PROTOCOLS;
  if (!allowed.has(url.protocol)) {
    throw new SsrfError(`disallowed protocol: ${url.protocol}`, 'DISALLOWED_PROTOCOL');
  }
  const host = url.hostname.toLowerCase();
  if (host.length === 0) {
    throw new SsrfError('missing hostname', 'MISSING_HOSTNAME');
  }
  if (DISALLOWED_HOSTS.has(host)) {
    throw new SsrfError(`disallowed hostname: ${host}`, 'DISALLOWED_HOST');
  }
  if (host.endsWith('.internal') || host.endsWith('.local')) {
    throw new SsrfError(`disallowed hostname suffix: ${host}`, 'DISALLOWED_SUFFIX');
  }
  // URL keeps IPv6 literals bracketed (`[::1]`); classify the bare address.
  const literal = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (isIP(literal) !== 0) {
    if (isDisallowedIp(literal)) {
      throw new SsrfError(`disallowed literal IP: ${literal}`, 'DISALLOWED_IP');
    }
    return url;
  }
  const resolve =
    options.resolveDns ??
    (async (h: string) => {
      const records = await dns.lookup(h, { all: true });
      return records.map((r) => ({ address: r.address }));
    });
  const records = await resolve(host);
  if (records.length === 0) {
    throw new SsrfError(`DNS returned no records for ${host}`, 'DNS_EMPTY');
  }
  for (const rec of records) {
    if (isDisallowedIp(rec.address)) {
      throw new SsrfError(
        `${host} resolves to disallowed address ${rec.address}`,
        'DISALLOWED_RESOLVED_IP',
      );
    }
  }
  return url;
}
