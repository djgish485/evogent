import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { POST } from './route';

const originalFetch = globalThis.fetch;
const originalInternalBaseUrl = process.env.MEDIA_AGENT_INTERNAL_BASE_URL;

describe('/api/internal/feed-actions/dispatch', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalInternalBaseUrl === undefined) {
      delete process.env.MEDIA_AGENT_INTERNAL_BASE_URL;
    } else {
      process.env.MEDIA_AGENT_INTERNAL_BASE_URL = originalInternalBaseUrl;
    }
  });

  test('routes x.follow to the skill-routed feed_action lane', async () => {
    let capturedUrl = '';
    let capturedBody: Record<string, unknown> | null = null;
    process.env.MEDIA_AGENT_INTERNAL_BASE_URL = 'http://127.0.0.1:3999';
    globalThis.fetch = async (url, init) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
      return Response.json({ ok: true, requestId: 'feed-action-test', priority: 'feed_action' }, { status: 202 });
    };

    const response = await POST(new Request('http://127.0.0.1/api/internal/feed-actions/dispatch', {
      method: 'POST',
      body: JSON.stringify({ itemId: 'follow-card-1', actionId: 'x.follow', payload: { handle: 'nickcammarata' } }),
    }));
    const result = await response.json() as Record<string, unknown>;

    assert.equal(response.status, 202);
    assert.equal(result.ok, true);
    assert.equal(capturedUrl, 'http://127.0.0.1:3999/api/orchestrator/enqueue');
    assert.equal(capturedBody?.priority, 'feed_action');
    assert.equal(capturedBody?.source, 'feed_action_dispatch');
    assert.match(String(capturedBody?.message), /Feed action handlers/);
    assert.match(String(capturedBody?.message), /x\.follow/);

    const metadata = capturedBody?.metadata as { feedAction?: Record<string, unknown>; requiresBrowserTools?: boolean };
    assert.equal(metadata.requiresBrowserTools, true);
    assert.deepEqual(metadata.feedAction, {
      actionId: 'x.follow',
      itemId: 'follow-card-1',
      payload: { handle: 'nickcammarata' },
      namespace: 'x',
      skillName: 'tweet-cache',
      skillPath: `${process.cwd()}/.claude/skills/tweet-cache/SKILL.md`,
    });
  });

  test('rejects an unclaimed namespace without enqueueing', async () => {
    let calledFetch = false;
    globalThis.fetch = async () => {
      calledFetch = true;
      return Response.json({ ok: true });
    };

    const response = await POST(new Request('http://127.0.0.1/api/internal/feed-actions/dispatch', {
      method: 'POST',
      body: JSON.stringify({ itemId: 'follow-card-1', actionId: 'missing.follow', payload: {} }),
    }));
    const result = await response.json() as { error?: string };

    assert.equal(response.status, 400);
    assert.match(result.error || '', /No installed skill claims feed action namespace "missing"/);
    assert.equal(calledFetch, false);
  });
});
