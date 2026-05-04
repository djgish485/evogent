import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { POST as postChat } from '../src/app/api/chat/route';
import { getDb } from '../src/lib/db/client';
import { recordBrowseCacheRefresh } from '../src/lib/db/browse-cache';
import {
  DEFAULT_CURATOR_CHAT_SESSION_ID,
  ensureDefaultAppChatSessions,
} from '../src/lib/db/chat-sessions';

type GlobalWithDb = typeof globalThis & {
  evogentDb?: {
    close: () => void;
  };
};

const globalWithDb = globalThis as GlobalWithDb;

function closeDb() {
  if (globalWithDb.evogentDb) {
    globalWithDb.evogentDb.close();
    delete globalWithDb.evogentDb;
  }
}

async function writeReadyRuntimeConfig(tempDir: string) {
  const dataDir = path.join(tempDir, 'data');
  const skillsDir = path.join(tempDir, 'skills');
  const binDir = path.join(tempDir, 'bin');

  await fs.promises.mkdir(path.join(skillsDir, 'hackernews-cache'), { recursive: true });
  await fs.promises.mkdir(binDir, { recursive: true });
  await fs.promises.mkdir(dataDir, { recursive: true });

  await fs.promises.writeFile(path.join(binDir, 'claude'), '#!/usr/bin/env sh\necho claude-test\n', { mode: 0o755 });
  await fs.promises.writeFile(path.join(skillsDir, 'hackernews-cache', 'SKILL.md'), `---
name: hackernews-cache
description: Test Hacker News source.
metadata:
  evogent:
    heartbeat-task: false
    feed-source: hackernews
    feed-source-label: Hacker News
---
# Hacker News Cache
`, 'utf8');
  await fs.promises.writeFile(path.join(dataDir, 'config.md'), `# Evogent Config

## Brain Provider
Claude Code

## Automatic Curation
On

## Curation Schedule
- Minimum interval: 1 minute
- Maximum interval: 1 minute
`, 'utf8');

  return { dataDir, skillsDir, binDir };
}

async function postCurate(originView: 'feed' | 'feed/setup_card') {
  const response = await postChat(new Request('http://127.0.0.1/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: '/curate',
      sessionId: DEFAULT_CURATOR_CHAT_SESSION_ID,
      context: null,
      inReplyTo: null,
      contextKind: 'global',
      contextRefId: null,
      originView,
    }),
  }));

  assert.strictEqual(response.status, 202);
  return await response.json() as Record<string, unknown>;
}

test('heartbeat, setup-card, and user /curate all use one Curator Agent chat session', async () => {
  const originalEnv = {
    dataDir: process.env.DATA_DIR,
    dbPath: process.env.MEDIA_AGENT_DB_PATH,
    skillsDir: process.env.MEDIA_AGENT_SKILLS_DIR,
    path: process.env.PATH,
    disableBackgroundJobs: process.env.MEDIA_AGENT_DISABLE_BACKGROUND_JOBS,
    evogentRoot: process.env.MEDIA_AGENT_ROOT,
  };
  const originalFetch = globalThis.fetch;
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evogent-curator-chat-delivery-'));
  const enqueuedPayloads: Array<Record<string, unknown>> = [];

  try {
    closeDb();
    const { dataDir, skillsDir, binDir } = await writeReadyRuntimeConfig(tempDir);
    process.env.DATA_DIR = dataDir;
    process.env.MEDIA_AGENT_DB_PATH = path.join(dataDir, 'media-agent.db');
    process.env.MEDIA_AGENT_SKILLS_DIR = skillsDir;
    process.env.PATH = `${binDir}${path.delimiter}${originalEnv.path ?? ''}`;
    process.env.MEDIA_AGENT_ROOT = process.cwd();
    delete process.env.MEDIA_AGENT_DISABLE_BACKGROUND_JOBS;

    const now = Date.now();
    recordBrowseCacheRefresh({
      runId: 'setup-source-hackernews-curator-chat-delivery',
      source: 'hackernews',
      triggeredBy: 'setup-source-smoke',
      startedAtMs: now - 1000,
      completedAtMs: now,
      status: 'completed',
      itemsAdded: 1,
    });

    globalThis.fetch = (async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if (url.endsWith('/api/orchestrator/status')) {
        return new Response(JSON.stringify({
          sessionName: 'unit-test-session',
          queueDepth: 0,
          isProcessing: false,
          activeCurationAgent: null,
          activeReflectionAgent: null,
          brain: {
            sessionExists: true,
            working: false,
            paneTail: null,
            checkedAt: new Date().toISOString(),
          },
          currentTask: null,
          activeChatTasks: [],
          queued: [],
          history: [],
          updatedAt: new Date().toISOString(),
        }), { headers: { 'Content-Type': 'application/json' } });
      }

      if (url.endsWith('/api/orchestrator/enqueue')) {
        const payload = init?.body && typeof init.body === 'string'
          ? JSON.parse(init.body) as Record<string, unknown>
          : {};
        enqueuedPayloads.push(payload);

        return new Response(JSON.stringify({
          ok: true,
          requestId: typeof payload.requestId === 'string' ? payload.requestId : `queue-${enqueuedPayloads.length}`,
          priority: payload.priority ?? 'user_chat',
          queueDepth: enqueuedPayloads.length,
          position: enqueuedPayloads.length,
          acceptedAt: new Date().toISOString(),
        }), { headers: { 'Content-Type': 'application/json' } });
      }

      throw new Error(`Unexpected fetch in curator chat delivery test: ${url}`);
    }) as typeof fetch;

    const { evaluateAdaptiveHeartbeat } = await import('../src/lib/heartbeat-service');
    const heartbeat = await evaluateAdaptiveHeartbeat({
      triggeredBy: 'unit-test',
      latestActivity: {
        event: 'pull_refresh',
        timestamp: new Date().toISOString(),
      },
    });
    assert.strictEqual(heartbeat.triggered, true);

    ensureDefaultAppChatSessions({
      provider: 'claude',
      workingDirectory: process.cwd(),
    });

    const setupResponse = await postCurate('feed/setup_card');
    const userResponse = await postCurate('feed');
    assert.strictEqual(setupResponse.sessionId, DEFAULT_CURATOR_CHAT_SESSION_ID);
    assert.strictEqual(userResponse.sessionId, DEFAULT_CURATOR_CHAT_SESSION_ID);

    const db = getDb();
    const curatorSessions = db.prepare(`
      SELECT id, title, session_type
      FROM chat_sessions
      WHERE session_type = 'curator'
      ORDER BY id ASC
    `).all() as Array<{ id: string; title: string; session_type: string | null }>;
    assert.deepStrictEqual(curatorSessions, [{
      id: DEFAULT_CURATOR_CHAT_SESSION_ID,
      title: 'Curator Agent',
      session_type: 'curator',
    }]);

    const automatedCount = db.prepare(`
      SELECT COUNT(*) AS count
      FROM chat_sessions
      WHERE title = 'Automated Curator'
    `).get() as { count: number };
    assert.strictEqual(automatedCount.count, 0);

    const curateMessageSessions = db.prepare(`
      SELECT DISTINCT session_id
      FROM chat_messages
      WHERE role = 'user'
        AND type = 'chat'
        AND text = '/curate'
      ORDER BY session_id ASC
    `).all() as Array<{ session_id: string }>;
    assert.deepStrictEqual(curateMessageSessions, [{ session_id: DEFAULT_CURATOR_CHAT_SESSION_ID }]);

    const curateMessageCount = db.prepare(`
      SELECT COUNT(*) AS count
      FROM chat_messages
      WHERE role = 'user'
        AND type = 'chat'
        AND text = '/curate'
        AND session_id = ?
    `).get(DEFAULT_CURATOR_CHAT_SESSION_ID) as { count: number };
    assert.strictEqual(curateMessageCount.count, 3);

    assert.strictEqual(enqueuedPayloads.length, 3);
    for (const payload of enqueuedPayloads) {
      const metadata = payload.metadata as Record<string, unknown>;
      assert.strictEqual(payload.priority, 'user_chat');
      assert.strictEqual(metadata.endpoint, '/api/chat');
      assert.strictEqual(metadata.sessionId, DEFAULT_CURATOR_CHAT_SESSION_ID);
      assert.strictEqual(metadata.sessionType, 'curator');
      assert.strictEqual(metadata.requiresBrowserTools, true);
    }
  } finally {
    globalThis.fetch = originalFetch;
    closeDb();

    if (originalEnv.dataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalEnv.dataDir;
    if (originalEnv.dbPath === undefined) delete process.env.MEDIA_AGENT_DB_PATH;
    else process.env.MEDIA_AGENT_DB_PATH = originalEnv.dbPath;
    if (originalEnv.skillsDir === undefined) delete process.env.MEDIA_AGENT_SKILLS_DIR;
    else process.env.MEDIA_AGENT_SKILLS_DIR = originalEnv.skillsDir;
    if (originalEnv.path === undefined) delete process.env.PATH;
    else process.env.PATH = originalEnv.path;
    if (originalEnv.disableBackgroundJobs === undefined) delete process.env.MEDIA_AGENT_DISABLE_BACKGROUND_JOBS;
    else process.env.MEDIA_AGENT_DISABLE_BACKGROUND_JOBS = originalEnv.disableBackgroundJobs;
    if (originalEnv.evogentRoot === undefined) delete process.env.MEDIA_AGENT_ROOT;
    else process.env.MEDIA_AGENT_ROOT = originalEnv.evogentRoot;

    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});
