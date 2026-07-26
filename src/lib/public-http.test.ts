import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { describe, test } from 'node:test';
import {
  fetchPublicHttpText,
  resolvePublicHttpUrl,
  UnsafePublicHttpUrlError,
  type PublicDnsLookup,
} from '@/lib/public-http';

describe('public HTTP URL boundary', () => {
  for (const url of [
    'http://127.0.0.1/private',
    'http://2130706433/private',
    'http://[::1]/private',
    'http://[fec0::1]/private',
    'http://169.254.169.254/metadata',
    'http://10.0.0.1/private',
    'http://localhost/private',
    'http://service.internal./private',
    'http://service.internal/private',
    'file:///etc/passwd',
    'https://user:secret@example.com/',
  ]) {
    test(`rejects ${url}`, async () => {
      await assert.rejects(
        resolvePublicHttpUrl(url),
        UnsafePublicHttpUrlError,
      );
    });
  }

  test('rejects a hostname with any private DNS answer', async () => {
    const lookup: PublicDnsLookup = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '192.168.1.4', family: 4 },
    ];
    await assert.rejects(
      resolvePublicHttpUrl('https://example.com/article', lookup),
      /non-public address/,
    );
  });

  test('rejects deprecated IPv6 site-local DNS answers', async () => {
    const lookup: PublicDnsLookup = async () => [
      { address: 'fec0::1234', family: 6 },
    ];
    await assert.rejects(
      resolvePublicHttpUrl('https://example.com/article', lookup),
      /non-public address/,
    );
  });

  test('accepts a hostname only when every pinned answer is public', async () => {
    const lookup: PublicDnsLookup = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ];
    const resolved = await resolvePublicHttpUrl('https://example.com/article', lookup);
    assert.strictEqual(resolved.url.hostname, 'example.com');
    assert.deepStrictEqual(resolved.addresses, [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ]);
  });

  test('bounds a DNS lookup that never settles inside the total request budget', async () => {
    const lookup: PublicDnsLookup = () => new Promise(() => {});
    const started = performance.now();
    await assert.rejects(
      fetchPublicHttpText('https://example.com/article', {
        timeoutMs: 25,
        maxBytes: 1_000,
        lookup,
      }),
      /timed out/,
    );
    assert.ok(performance.now() - started < 250);
  });

  test('shares one wall-clock timeout across redirect hops', async (context) => {
    let requests = 0;
    context.mock.method(http, 'request', ((
      _url: URL,
      _options: unknown,
      callback: (response: EventEmitter & {
        headers: Record<string, string>;
        statusCode: number;
        destroy: () => void;
      }) => void,
    ) => {
      const request = new EventEmitter() as EventEmitter & {
        destroy: (error?: Error) => void;
        end: () => void;
      };
      request.destroy = (error?: Error) => {
        if (error) request.emit('error', error);
      };
      request.end = () => {
        requests += 1;
        setTimeout(() => {
          const response = new EventEmitter() as EventEmitter & {
            headers: Record<string, string>;
            statusCode: number;
            destroy: () => void;
          };
          response.statusCode = 302;
          response.headers = { location: `http://example.com/hop-${requests}` };
          response.destroy = () => {};
          callback(response);
          response.emit('end');
        }, 20);
      };
      return request;
    }) as typeof http.request);

    const lookup: PublicDnsLookup = async () => [
      { address: '93.184.216.34', family: 4 },
    ];
    const started = performance.now();
    await assert.rejects(
      fetchPublicHttpText('http://example.com/start', {
        timeoutMs: 45,
        maxBytes: 1_000,
        maxRedirects: 10,
        lookup,
      }),
      /timed out/,
    );
    assert.ok(requests >= 2 && requests <= 3);
    assert.ok(performance.now() - started < 250);
  });
});
