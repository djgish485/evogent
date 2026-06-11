import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildOpenClawPreCurationCacheRefreshPayload,
  isFullOpenClawCurationRequest,
  OPENCLAW_PRE_CURATION_CACHE_REFRESH_TIMEOUT_MS,
  refreshCachesBeforeOpenClawCuration,
} from './pre-curation-cache';

describe('OpenClaw pre-curation cache refresh', () => {
  test('recognizes full curator requests but skips curate-latest requests', () => {
    assert.strictEqual(isFullOpenClawCurationRequest('/curate'), true);
    assert.strictEqual(isFullOpenClawCurationRequest('Run a full curation cycle now.'), true);
    assert.strictEqual(isFullOpenClawCurationRequest('Run one Evogent curation cycle now.'), true);
    assert.strictEqual(isFullOpenClawCurationRequest('/curate-latest'), false);
    assert.strictEqual(isFullOpenClawCurationRequest('latest-content-focused curation'), false);
  });

  test('builds a waiting refresh payload for automated full curation', () => {
    const payload = buildOpenClawPreCurationCacheRefreshPayload('/curate', 'request-123');

    assert.strictEqual(payload.waitForCompletion, true);
    assert.strictEqual(payload.timeoutMs, OPENCLAW_PRE_CURATION_CACHE_REFRESH_TIMEOUT_MS);
    assert.ok(OPENCLAW_PRE_CURATION_CACHE_REFRESH_TIMEOUT_MS < 300_000);
    assert.strictEqual(payload.task.id, 'request-123');
    assert.strictEqual(payload.task.priority, 'heartbeat');
    assert.strictEqual(payload.task.metadata.automatedCuration, true);
    assert.strictEqual(payload.task.metadata.curationCommand, '/curate');
  });

  test('posts the waiting refresh request before full curation proceeds', async () => {
    let requestedUrl = '';
    let requestedInit: RequestInit | undefined;

    await refreshCachesBeforeOpenClawCuration('Run a full curation cycle now.', 'request-456', {
      getBaseUrl: () => 'http://evogent.test',
      fetchImpl: async (input, init) => {
        requestedUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        requestedInit = init;
        return new Response(JSON.stringify({ ok: true, timedOut: false }), {
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    assert.strictEqual(requestedUrl, 'http://evogent.test/api/internal/cache-refresh/pre-curation');
    assert.strictEqual(requestedInit?.method, 'POST');
    assert.strictEqual(requestedInit?.cache, 'no-store');
    const body = JSON.parse(String(requestedInit?.body ?? '{}')) as ReturnType<typeof buildOpenClawPreCurationCacheRefreshPayload>;
    assert.strictEqual(body.waitForCompletion, true);
    assert.strictEqual(body.timeoutMs, OPENCLAW_PRE_CURATION_CACHE_REFRESH_TIMEOUT_MS);
    assert.strictEqual(body.task.id, 'request-456');
    assert.strictEqual(body.task.message, 'Run a full curation cycle now.');
  });

  test('fails full curation when cache refresh times out', async () => {
    await assert.rejects(
      refreshCachesBeforeOpenClawCuration('Run a full curation cycle now.', 'request-timeout', {
        getBaseUrl: () => 'http://evogent.test',
        fetchImpl: async () => new Response(JSON.stringify({
          ok: true,
          timedOut: true,
          pendingSources: ['twitter', 'substack'],
        }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      }),
      /timed out.*twitter, substack/,
    );
  });

  test('fails full curation when a source refresh does not complete cleanly', async () => {
    await assert.rejects(
      refreshCachesBeforeOpenClawCuration('/curate', 'request-failed-source', {
        getBaseUrl: () => 'http://evogent.test',
        fetchImpl: async () => new Response(JSON.stringify({
          ok: true,
          timedOut: false,
          sourceResults: [
            { source: 'twitter', result: 'run_recorded', status: 'completed' },
            { source: 'substack', result: 'failed', error: 'browser session unavailable' },
          ],
        }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      }),
      /substack:failed.*browser session unavailable/,
    );
  });

  test('does not refresh caches for lightweight latest-content curation', async () => {
    let called = false;

    await refreshCachesBeforeOpenClawCuration('/curate-latest', 'request-789', {
      getBaseUrl: () => 'http://evogent.test',
      fetchImpl: async () => {
        called = true;
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    assert.strictEqual(called, false);
  });
});
