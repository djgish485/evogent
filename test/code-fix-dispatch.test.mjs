import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { dispatchCodeFixSuggestionsDirect } = require('../lib/code-fix-dispatch.js');
const { settleDispatchResults } = require('../lib/code-fix-dispatch-worker.js');

test('direct code_fix dispatch passes descriptor provenance to the self-orchestrating spawner', async () => {
  const spawnCalls = [];
  const results = await dispatchCodeFixSuggestionsDirect([
    {
      id: 'code-fix-preserve-origin-session',
      suggestionId: 'code-fix-preserve-origin-session',
      feedItemId: 'code-fix-preserve-origin-session',
      originSessionId: 'session-origin-123',
      taskId: 'fix-preserve-origin-session-123',
      title: 'Preserve origin session',
      text: 'This chat context should not be injected into the dev-agent prompt.',
      proposedValue: 'Implement the provenance plumbing only.',
    },
  ], {
    repoDir: '/tmp/evogent-test-repo',
    spawnSelfOrchestratingDevAgent(args) {
      spawnCalls.push(args);
      return {
        taskId: args.taskId,
        provider: 'claude',
        worktree: `/tmp/evogent-test-repo-worktrees/${args.taskId}`,
        branch: args.taskId,
        launch: { mode: 'tmux', tmuxSession: `agent-${args.taskId}` },
      };
    },
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true);
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].taskId, 'fix-preserve-origin-session-123');
  assert.equal(spawnCalls[0].suggestion.id, 'code-fix-preserve-origin-session');
  assert.equal(spawnCalls[0].suggestion.suggestionId, 'code-fix-preserve-origin-session');
  assert.equal(spawnCalls[0].suggestion.feedItemId, 'code-fix-preserve-origin-session');
  assert.equal(spawnCalls[0].suggestion.originSessionId, 'session-origin-123');
  assert.equal(spawnCalls[0].suggestion.proposedValue, 'Implement the provenance plumbing only.');
  assert.equal(spawnCalls[0].options.repoDir, '/tmp/evogent-test-repo');
});

test('direct code_fix dispatch reports max-agent capacity as queued retryable work', async () => {
  const results = await dispatchCodeFixSuggestionsDirect([
    {
      id: 'code-fix-capacity',
      suggestionId: 'code-fix-capacity',
      feedItemId: 'code-fix-capacity',
      taskId: 'fix-capacity-123',
      proposedValue: 'Implement only the accepted code fix.',
    },
  ], {
    repoDir: '/tmp/evogent-test-repo',
    spawnSelfOrchestratingDevAgent() {
      throw new Error('Max concurrent agents (4) reached. Active: 4');
    },
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].ok, false);
  assert.equal(results[0].retryable, true);
  assert.equal(results[0].noSlotAvailable, true);
  assert.match(results[0].error, /Max concurrent agents/);
});

test('dispatch worker keeps max-agent capacity lifecycle queued instead of failed', async () => {
  const posts = [];
  const originalFetch = globalThis.fetch;
  const originalBaseUrl = process.env.MEDIA_AGENT_INTERNAL_BASE_URL;
  process.env.MEDIA_AGENT_INTERNAL_BASE_URL = 'http://127.0.0.1:3156';
  globalThis.fetch = async (url, init) => {
    posts.push({ url: String(url), body: JSON.parse(String(init?.body || '{}')) });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };

  try {
    await settleDispatchResults([
      {
        ok: false,
        skipped: false,
        retryable: true,
        noSlotAvailable: true,
        suggestionId: 'code-fix-capacity',
        taskId: 'fix-capacity-123',
        error: 'Max concurrent agents (4) reached. Active: 4',
      },
    ]);

    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, 'http://127.0.0.1:3156/api/internal/code-fix/report');
    assert.equal(posts[0].body.status, 'progress');
    assert.equal(posts[0].body.phase, 'agent_dispatch');
    assert.match(posts[0].body.reason, /Max concurrent agents/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalBaseUrl === undefined) {
      delete process.env.MEDIA_AGENT_INTERNAL_BASE_URL;
    } else {
      process.env.MEDIA_AGENT_INTERNAL_BASE_URL = originalBaseUrl;
    }
  }
});
