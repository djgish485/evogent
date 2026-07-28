import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { validateBenchmarkSharePayload } from './browse-benchmark-proof';
import type { UpsertBrowseCacheItemInput } from './db/browse-cache';

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function validRequest(): {
  payload: Record<string, unknown>;
  items: UpsertBrowseCacheItemInput[];
} {
  const sourceId = 'AAAAAAAAAAA';
  const tokenDigest = digest('private one-shot token');
  const receiptId = `benchmark-share-${tokenDigest}`;
  const armedAtMs = Date.now() - 100;
  const fetchedAtMs = armedAtMs + 20;
  const items: UpsertBrowseCacheItemInput[] = [{
    source: 'youtube',
    sourceId,
    url: `https://www.youtube.com/watch?v=${sourceId}`,
    title: 'Substantive benchmark video',
    payload: {
      type: 'youtube',
      videoId: sourceId,
      title: 'Substantive benchmark video',
    },
    fetchedAtMs,
    expiresAtMs: fetchedAtMs + 60_000,
  }];
  return {
    items,
    payload: {
      runId: receiptId,
      source: 'youtube',
      triggeredBy: 'phone-benchmark-full-browse-share',
      startedAtMs: fetchedAtMs,
      completedAtMs: fetchedAtMs,
      status: 'completed',
      itemsAdded: 1,
      items,
      metadata: {
        benchmarkShareProof: {
          schemaVersion: 1,
          kind: 'full_browse_share',
          benchmarkRunId: 'full-browse-test-suite-12345678',
          sequence: 1,
          receiptId,
          tokenDigest,
          sourceIdDigest: digest(sourceId),
          armedAtMs,
          fetchedAtMs,
        },
      },
    },
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

test('server accepts an exact token-bound benchmark share receipt', () => {
  const request = validRequest();
  assert.doesNotThrow(() => validateBenchmarkSharePayload(request.payload, request.items));
});

test('ordinary browse ingestion remains outside the benchmark protocol', () => {
  assert.doesNotThrow(() => validateBenchmarkSharePayload({
    source: 'youtube',
    triggeredBy: 'phone-browse',
  }, []));
});

test('server rejects independently forged benchmark receipt dimensions', async (t) => {
  const mutations: Array<[string, (request: ReturnType<typeof validRequest>) => void]> = [
    ['missing proof', ({ payload }) => { delete payload.metadata; }],
    ['raw source mismatch', ({ items }) => { items[0].sourceId = 'BBBBBBBBBBB'; }],
    ['canonical URL mismatch', ({ items }) => { items[0].url = 'https://youtu.be/AAAAAAAAAAA'; }],
    ['token receipt mismatch', ({ payload }) => {
      const metadata = payload.metadata as Record<string, unknown>;
      const proof = metadata.benchmarkShareProof as Record<string, unknown>;
      proof.tokenDigest = digest('another token');
    }],
    ['invalid run identity', ({ payload }) => {
      const metadata = payload.metadata as Record<string, unknown>;
      const proof = metadata.benchmarkShareProof as Record<string, unknown>;
      proof.benchmarkRunId = 'browse-other-suite';
    }],
    ['sequence overflow', ({ payload }) => {
      const metadata = payload.metadata as Record<string, unknown>;
      const proof = metadata.benchmarkShareProof as Record<string, unknown>;
      proof.sequence = 6;
    }],
    ['expired arm', ({ payload }) => {
      const metadata = payload.metadata as Record<string, unknown>;
      const proof = metadata.benchmarkShareProof as Record<string, unknown>;
      proof.armedAtMs = Number(proof.fetchedAtMs) - 120_001;
    }],
    ['extra durable metadata', ({ payload }) => {
      const metadata = payload.metadata as Record<string, unknown>;
      metadata.sourceTitle = 'must not persist';
    }],
  ];

  for (const [name, mutate] of mutations) {
    await t.test(name, () => {
      const request = clone(validRequest());
      mutate(request);
      assert.throws(
        () => validateBenchmarkSharePayload(request.payload, request.items),
        /Invalid benchmark share receipt/,
      );
    });
  }
});
