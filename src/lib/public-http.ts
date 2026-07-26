import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net, { type LookupFunction } from 'node:net';

const blockedIpv4 = new net.BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blockedIpv4.addSubnet(network, prefix, 'ipv4');
}

const blockedIpv6 = new net.BlockList();
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fec0::', 10],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blockedIpv6.addSubnet(network, prefix, 'ipv6');
}

const nonPublicHostnameSuffixes = [
  'localhost',
  '.localhost',
  '.local',
  '.internal',
  '.home.arpa',
  '.invalid',
  '.test',
];

export class UnsafePublicHttpUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafePublicHttpUrlError';
  }
}

export interface ResolvedPublicAddress {
  address: string;
  family: 4 | 6;
}

export type PublicDnsLookup = (
  hostname: string,
) => Promise<ReadonlyArray<ResolvedPublicAddress>>;

export interface PublicHttpTextResponse {
  status: number;
  contentType: string;
  text: string;
  finalUrl: string;
}

function normalizedHostname(url: URL): string {
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

function isPublicAddress(address: string, family: 4 | 6): boolean {
  if (family === 4) {
    return net.isIP(address) === 4 && !blockedIpv4.check(address, 'ipv4');
  }
  return net.isIP(address) === 6 && !blockedIpv6.check(address, 'ipv6');
}

async function systemLookup(hostname: string): Promise<ResolvedPublicAddress[]> {
  const rows = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return rows.map(({ address, family }) => ({
    address,
    family: family === 6 ? 6 : 4,
  }));
}

/**
 * Resolve a source URL before any request and reject the whole hostname if even
 * one answer reaches a private, loopback, link-local, multicast, documentation,
 * or otherwise non-routable range. Rejecting mixed answers prevents a public
 * answer from laundering a private DNS-rebinding target.
 */
export async function resolvePublicHttpUrl(
  rawUrl: string,
  lookup: PublicDnsLookup = systemLookup,
): Promise<{ url: URL; addresses: ResolvedPublicAddress[] }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafePublicHttpUrlError('URL is not valid');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafePublicHttpUrlError('URL must use HTTP or HTTPS');
  }
  if (url.username || url.password) {
    throw new UnsafePublicHttpUrlError('URL credentials are not allowed');
  }
  const hostname = normalizedHostname(url);
  if (!hostname || hostname.includes('%')) {
    throw new UnsafePublicHttpUrlError('URL hostname is not safe');
  }
  if (nonPublicHostnameSuffixes.some((suffix) => (
    suffix.startsWith('.') ? hostname.endsWith(suffix) : hostname === suffix
  ))) {
    throw new UnsafePublicHttpUrlError('URL hostname is not public');
  }

  const literalFamily = net.isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily === 6 ? 6 as const : 4 as const }]
    : [...await lookup(hostname)];
  if (addresses.length === 0) {
    throw new Error('URL hostname did not resolve');
  }
  if (addresses.some(({ address, family }) => !isPublicAddress(address, family))) {
    throw new UnsafePublicHttpUrlError('URL resolves to a non-public address');
  }
  // Prefer IPv4 on mobile networks when both families are present, but keep the
  // complete validated set so a connector can fall back without another DNS
  // lookup.
  addresses.sort((left, right) => left.family - right.family);
  return { url, addresses };
}

function requestOnce(
  url: URL,
  addresses: ResolvedPublicAddress[],
  options: {
    headers: Record<string, string>;
    timeoutMs: number;
    maxBytes: number;
  },
): Promise<{
  status: number;
  contentType: string;
  location: string | null;
  text: string;
}> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    const clearDeadline = () => {
      if (deadlineTimer) {
        clearTimeout(deadlineTimer);
        deadlineTimer = null;
      }
    };
    const finishReject = (error: Error) => {
      if (settled) return;
      settled = true;
      clearDeadline();
      reject(error);
    };
    const finishResolve = (value: {
      status: number;
      contentType: string;
      location: string | null;
      text: string;
    }) => {
      if (settled) return;
      settled = true;
      clearDeadline();
      resolve(value);
    };
    const transport = url.protocol === 'https:' ? https : http;
    const selected = addresses[0];
    const pinnedLookup: LookupFunction = (_hostname, lookupOptions, callback) => {
      if (lookupOptions.all) {
        callback(null, addresses);
        return;
      }
      callback(null, selected.address, selected.family);
    };
    const request = transport.request(url, {
      method: 'GET',
      family: selected.family,
      headers: {
        ...options.headers,
        'Accept-Encoding': 'identity',
      },
      lookup: pinnedLookup,
    }, (response) => {
      const chunks: Buffer[] = [];
      let storedBytes = 0;
      response.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const remaining = options.maxBytes - storedBytes;
        const stored = buffer.subarray(0, remaining);
        chunks.push(stored);
        storedBytes += stored.length;
        if (storedBytes >= options.maxBytes) {
          finishResolve({
            status: response.statusCode ?? 0,
            contentType: String(response.headers['content-type'] ?? ''),
            location: typeof response.headers.location === 'string'
              ? response.headers.location
              : null,
            text: Buffer.concat(chunks).toString('utf8'),
          });
          response.destroy();
        }
      });
      response.on('error', finishReject);
      response.on('end', () => {
        finishResolve({
          status: response.statusCode ?? 0,
          contentType: String(response.headers['content-type'] ?? ''),
          location: typeof response.headers.location === 'string'
            ? response.headers.location
            : null,
          text: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    deadlineTimer = setTimeout(() => {
      request.destroy(new Error('Public HTTP request timed out'));
    }, options.timeoutMs);
    request.on('error', finishReject);
    request.end();
  });
}

function remainingBudgetMs(deadline: number): number {
  const remaining = deadline - performance.now();
  if (remaining <= 0) {
    throw new Error('Public HTTP request timed out');
  }
  return remaining;
}

function withinBudget<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Public HTTP request timed out')),
      timeoutMs,
    );
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Fetch a bounded public HTTP document with connect-time DNS pinning. Redirects
 * are followed manually and every destination is independently resolved and
 * checked; HTTPS is never downgraded to HTTP.
 */
export async function fetchPublicHttpText(
  rawUrl: string,
  options: {
    headers?: Record<string, string>;
    timeoutMs: number;
    maxBytes: number;
    maxRedirects?: number;
    lookup?: PublicDnsLookup;
  },
): Promise<PublicHttpTextResponse> {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new TypeError('Public HTTP timeout must be positive');
  }
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) {
    throw new TypeError('Public HTTP byte limit must be a positive safe integer');
  }
  if (
    options.maxRedirects !== undefined
    && (!Number.isSafeInteger(options.maxRedirects) || options.maxRedirects < 0)
  ) {
    throw new TypeError('Public HTTP redirect limit must be a non-negative safe integer');
  }
  const maxRedirects = options.maxRedirects ?? 4;
  const deadline = performance.now() + options.timeoutMs;
  let current = rawUrl;
  let priorProtocol: string | null = null;
  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const resolved = await withinBudget(
      resolvePublicHttpUrl(current, options.lookup),
      remainingBudgetMs(deadline),
    );
    if (priorProtocol === 'https:' && resolved.url.protocol !== 'https:') {
      throw new UnsafePublicHttpUrlError('HTTPS redirects may not downgrade to HTTP');
    }
    const response = await requestOnce(resolved.url, resolved.addresses, {
      headers: options.headers ?? {},
      timeoutMs: remainingBudgetMs(deadline),
      maxBytes: options.maxBytes,
    });
    if (
      response.status >= 300
      && response.status < 400
      && response.location
    ) {
      if (redirectCount === maxRedirects) {
        throw new Error('Public HTTP redirect limit exceeded');
      }
      priorProtocol = resolved.url.protocol;
      current = new URL(response.location, resolved.url).toString();
      continue;
    }
    return {
      status: response.status,
      contentType: response.contentType,
      text: response.text,
      finalUrl: resolved.url.toString(),
    };
  }
  throw new Error('Public HTTP redirect limit exceeded');
}
