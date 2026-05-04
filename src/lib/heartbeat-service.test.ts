import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { getDataPath } from '@/lib/data-dir';
import { evaluateAdaptiveHeartbeat, completeAdaptiveHeartbeat } from './heartbeat-service';
import { getOrchestratorStatus } from './orchestrator';
import { getTriggerDecision } from './heartbeat';
import { getDb } from './db/client';
import { insertChatMessage, updateChatMessageStatus } from './db/chat';
import {
  createChatSession,
  DEFAULT_CURATOR_CHAT_SESSION_ID,
} from './db/chat-sessions';
import {
  completeCurationLogByRequestId,
  getCurationLogByRequestId,
  getLatestSuccessfulCurationTime,
  insertCurationLogStart,
} from './db/activity';

const LOCK_DIR = getDataPath('.orchestrator-test-lock');

type GlobalWithDb = typeof globalThis & {
  evogentDb?: {
    close: () => void;
  };
};

const globalWithDb = globalThis as GlobalWithDb;

async function acquireOrchestratorLock(timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      await fs.promises.mkdir(LOCK_DIR);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        throw error;
      }
    }

    await delay(100);
  }

  throw new Error('Timed out acquiring orchestrator test lock');
}

async function releaseOrchestratorLock(): Promise<void> {
  await fs.promises.rm(LOCK_DIR, { recursive: true, force: true });
}

async function withOrchestratorLock<T>(run: () => Promise<T>): Promise<T> {
  await acquireOrchestratorLock();
  try {
    return await run();
  } finally {
    await releaseOrchestratorLock();
  }
}

async function waitForNoQueuedHeartbeat(timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const status = await getOrchestratorStatus();
    const activeHeartbeat = typeof status.activeCurationAgent === 'string' && status.activeCurationAgent.trim().length > 0;
    const currentIsHeartbeat = status.currentTask?.priority === 'heartbeat';
    const queuedHeartbeat = status.queued.some((entry) => entry.priority === 'heartbeat');

    if (!activeHeartbeat && !currentIsHeartbeat && !queuedHeartbeat) {
      return;
    }

    await delay(200);
  }

  throw new Error('Timed out waiting for queued heartbeat to clear');
}

describe('heartbeat service', () => {
  let originalDbPath: string | undefined;
  let originalDataDir: string | undefined;
  let originalSkillsDir: string | undefined;
  let originalEvogentRoot: string | undefined;
  let originalPath: string | undefined;
  let originalFetch: typeof fetch;
  let tempDir = '';
  let enqueuePayload: Record<string, unknown> | null = null;

  beforeEach(async () => {
    originalDbPath = process.env.MEDIA_AGENT_DB_PATH;
    originalDataDir = process.env.DATA_DIR;
    originalSkillsDir = process.env.MEDIA_AGENT_SKILLS_DIR;
    originalEvogentRoot = process.env.MEDIA_AGENT_ROOT;
    originalPath = process.env.PATH;
    originalFetch = globalThis.fetch;
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evogent-heartbeat-test-'));

    if (globalWithDb.evogentDb) {
      globalWithDb.evogentDb.close();
      delete globalWithDb.evogentDb;
    }

    process.env.MEDIA_AGENT_DB_PATH = path.join(tempDir, 'media-agent.db');
    process.env.DATA_DIR = tempDir;
    process.env.MEDIA_AGENT_SKILLS_DIR = path.join(tempDir, 'skills');
    const binDir = path.join(tempDir, 'bin');
    await fs.promises.mkdir(binDir, { recursive: true });
    await fs.promises.mkdir(path.join(process.env.MEDIA_AGENT_SKILLS_DIR, 'hackernews-cache'), { recursive: true });
    await fs.promises.writeFile(path.join(binDir, 'claude'), '#!/usr/bin/env sh\necho claude-test\n', { mode: 0o755 });
    await fs.promises.writeFile(path.join(process.env.MEDIA_AGENT_SKILLS_DIR, 'hackernews-cache', 'SKILL.md'), `---
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
    await fs.promises.writeFile(path.join(tempDir, 'config.md'), `# Evogent Config

## Brain Provider
Claude Code

## Automatic Curation
On

## Curation Schedule
- Minimum interval: 1 minute
- Maximum interval: 1 minute
`, 'utf8');
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`;
    enqueuePayload = null;
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
          queued: [],
          history: [],
          updatedAt: new Date().toISOString(),
        }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.endsWith('/api/orchestrator/enqueue')) {
        const payload = init?.body && typeof init.body === 'string'
          ? JSON.parse(init.body) as { requestId?: string }
          : {};
        enqueuePayload = payload as Record<string, unknown>;

        return new Response(JSON.stringify({
          ok: true,
          requestId: payload.requestId ?? `heartbeat-test-${Date.now()}`,
          priority: 'heartbeat',
          queueDepth: 1,
          position: 1,
          acceptedAt: new Date().toISOString(),
        }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      throw new Error(`Unexpected fetch in heartbeat-service.test: ${url}`);
    }) as typeof fetch;
  });

  afterEach(async () => {
    if (globalWithDb.evogentDb) {
      globalWithDb.evogentDb.close();
      delete globalWithDb.evogentDb;
    }

    if (originalDbPath === undefined) {
      delete process.env.MEDIA_AGENT_DB_PATH;
    } else {
      process.env.MEDIA_AGENT_DB_PATH = originalDbPath;
    }

    if (originalDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = originalDataDir;
    }

    if (originalSkillsDir === undefined) {
      delete process.env.MEDIA_AGENT_SKILLS_DIR;
    } else {
      process.env.MEDIA_AGENT_SKILLS_DIR = originalSkillsDir;
    }

    if (originalEvogentRoot === undefined) {
      delete process.env.MEDIA_AGENT_ROOT;
    } else {
      process.env.MEDIA_AGENT_ROOT = originalEvogentRoot;
    }

    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }

    globalThis.fetch = originalFetch;

    if (tempDir) {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('evaluateAdaptiveHeartbeat reuses a startup-persisted curator session and queues its /curate message', async () => {
    await withOrchestratorLock(async () => {
      await waitForNoQueuedHeartbeat();
      process.env.MEDIA_AGENT_ROOT = '/root/evogent';
      const curatorSession = createChatSession({
        sessionType: 'curator',
        title: 'Newest Curator',
        workingDirectory: '/root/evogent-worktrees/should-not-run-here',
      });

      if (globalWithDb.evogentDb) {
        globalWithDb.evogentDb.close();
        delete globalWithDb.evogentDb;
      }

      const dbAfterStartup = getDb();
      const sessionCountBefore = (dbAfterStartup.prepare(`
        SELECT COUNT(*) AS count
        FROM chat_sessions
      `).get() as { count?: number } | undefined)?.count ?? 0;
      assert.strictEqual((dbAfterStartup.prepare(`
        SELECT COUNT(*) AS count
        FROM chat_sessions
        WHERE id = ?
      `).get(curatorSession.id) as { count?: number } | undefined)?.count ?? 0, 1);

      const result = await evaluateAdaptiveHeartbeat({
        triggeredBy: 'unit-test',
        latestActivity: {
          event: 'pull_refresh',
          timestamp: new Date().toISOString(),
        },
      });

      assert.strictEqual(result.triggered, true);
      assert.strictEqual(result.triggerReason, 'pull_refresh_immediate');
      assert.strictEqual(typeof result.requestId, 'string');
      assert.ok((result.requestId ?? '').length > 0);
      assert.ok(enqueuePayload);

      const chatMessageId = (enqueuePayload?.metadata as Record<string, unknown> | undefined)?.chatMessageId;
      assert.strictEqual(typeof chatMessageId, 'string');
      const row = getDb().prepare(`
        SELECT id, role, type, text, session_id, status
        FROM chat_messages
        WHERE id = ?
      `).get(chatMessageId) as {
        id: string;
        role: string;
        type: string;
        text: string;
        session_id: string;
        status: string | null;
      } | undefined;

      assert.ok(row);
      assert.strictEqual(row?.role, 'user');
      assert.strictEqual(row?.type, 'chat');
      assert.strictEqual(row?.text, '/curate');
      assert.strictEqual(row?.session_id, curatorSession.id);
      assert.strictEqual(row?.status, 'queued');
      const curationLogEntry = getCurationLogByRequestId(result.requestId as string);
      assert.ok(curationLogEntry);
      assert.strictEqual(curationLogEntry?.requestId, result.requestId);
      assert.strictEqual(curationLogEntry?.completedAt, null);
      assert.strictEqual(curationLogEntry?.triggeredBy, 'adaptive_heartbeat:unit-test:pull_refresh_immediate');
      assert.strictEqual((getDb().prepare(`
        SELECT COUNT(*) AS count
        FROM chat_sessions
      `).get() as { count?: number } | undefined)?.count ?? 0, sessionCountBefore);

      assert.strictEqual(enqueuePayload?.priority, 'user_chat');
      assert.strictEqual(enqueuePayload?.source, 'adaptive_heartbeat:unit-test');
      assert.strictEqual(enqueuePayload?.requestId, result.requestId);
      assert.strictEqual(
        (enqueuePayload?.metadata as Record<string, unknown> | undefined)?.sessionId,
        curatorSession.id,
      );
      assert.strictEqual(
        (enqueuePayload?.metadata as Record<string, unknown> | undefined)?.chatMessageId,
        row?.id,
      );
      assert.strictEqual(
        (enqueuePayload?.metadata as Record<string, unknown> | undefined)?.workingDirectory,
        process.cwd(),
      );
      assert.strictEqual(
        (enqueuePayload?.metadata as Record<string, unknown> | undefined)?.triggerSource,
        'adaptive_heartbeat:unit-test',
      );
      assert.strictEqual(
        (enqueuePayload?.metadata as Record<string, unknown> | undefined)?.heartbeatTriggeredBy,
        'unit-test',
      );
      assert.strictEqual(
        (enqueuePayload?.metadata as Record<string, unknown> | undefined)?.automatedCuration,
        true,
      );
      assert.deepStrictEqual(
        (enqueuePayload?.metadata as Record<string, unknown> | undefined)?.heartbeatSessionResolution,
        {
          reusedSessionId: curatorSession.id,
          createdSessionId: null,
          workingDirectory: process.cwd(),
        },
      );
      assert.strictEqual(
        (enqueuePayload?.metadata as Record<string, unknown> | undefined)?.curationLogRequestId,
        result.requestId,
      );
    });
  });

  test('evaluateAdaptiveHeartbeat deduplicates rapid app-open auto-curate requests', async () => {
    await withOrchestratorLock(async () => {
      await waitForNoQueuedHeartbeat();
      const curatorSession = createChatSession({
        sessionType: 'curator',
        title: 'Rapid App Open Curator',
        workingDirectory: process.cwd(),
      });

      const firstResult = await evaluateAdaptiveHeartbeat({
        triggeredBy: 'activity:app_open',
        latestActivity: {
          event: 'app_open',
          timestamp: new Date().toISOString(),
        },
      });

      assert.strictEqual(firstResult.triggered, true);
      assert.strictEqual(firstResult.triggerReason, 'app_open_auto');
      assert.ok(firstResult.requestId);

      const secondResult = await evaluateAdaptiveHeartbeat({
        triggeredBy: 'activity:app_open',
        latestActivity: {
          event: 'app_open',
          timestamp: new Date().toISOString(),
        },
      });

      assert.strictEqual(secondResult.triggered, false);
      assert.strictEqual(secondResult.triggerReason, 'curation_cycle_pending');
      assert.strictEqual(secondResult.requestId, null);

      const queuedRows = getDb().prepare(`
        SELECT id
        FROM chat_messages
        WHERE session_id = ?
          AND role = 'user'
          AND text = '/curate'
      `).all(curatorSession.id) as Array<{ id: string }>;

      assert.strictEqual(queuedRows.length, 1);
      assert.ok(getCurationLogByRequestId(firstResult.requestId as string));
    });
  });

  test('evaluateAdaptiveHeartbeat treats automated cancellation as a scheduler cooldown shared by timer and cron', async () => {
    await withOrchestratorLock(async () => {
      await waitForNoQueuedHeartbeat();
      const curatorSession = createChatSession({
        sessionType: 'curator',
        title: 'Cancelled Auto Curator',
        workingDirectory: process.cwd(),
      });
      const appOpenAt = new Date().toISOString();

      const timerResult = await evaluateAdaptiveHeartbeat({
        triggeredBy: 'timer',
        latestActivity: {
          event: 'app_open',
          timestamp: appOpenAt,
        },
      });

      assert.strictEqual(timerResult.triggered, true);
      assert.strictEqual(timerResult.triggerReason, 'app_open_auto');
      assert.ok(timerResult.requestId);
      const timerPayload = enqueuePayload;
      const chatMessageId = (timerPayload?.metadata as Record<string, unknown> | undefined)?.chatMessageId;
      assert.strictEqual(typeof chatMessageId, 'string');

      updateChatMessageStatus(chatMessageId as string, 'cancelled');
      completeCurationLogByRequestId(timerResult.requestId as string, {
        completedAt: new Date().toISOString(),
        itemsAdded: 0,
        completionStatus: 'cancelled',
        completionReason: 'chat message was cancelled before curation output',
      });
      enqueuePayload = null;

      const cronResult = await evaluateAdaptiveHeartbeat({
        triggeredBy: 'cron',
        latestActivity: {
          event: 'app_open',
          timestamp: appOpenAt,
        },
      });

      assert.strictEqual(cronResult.triggered, false);
      assert.strictEqual(cronResult.triggerReason, 'user_cancel_cooldown_active');
      assert.strictEqual(cronResult.requestId, null);
      assert.strictEqual(enqueuePayload, null);

      const queuedRows = getDb().prepare(`
        SELECT id
        FROM chat_messages
        WHERE session_id = ?
          AND role = 'user'
          AND text = '/curate'
      `).all(curatorSession.id) as Array<{ id: string }>;

      assert.strictEqual(queuedRows.length, 1);
    });
  });

  test('evaluateAdaptiveHeartbeat creates the default Curator Agent session when none exists', async () => {
    process.env.MEDIA_AGENT_ROOT = '/root/evogent';
    const result = await evaluateAdaptiveHeartbeat({
      triggeredBy: 'unit-test-new-session',
      latestActivity: {
        event: 'pull_refresh',
        timestamp: new Date().toISOString(),
      },
    });

    assert.strictEqual(result.triggered, true);

    const sessionRows = getDb().prepare(`
      SELECT id, title, session_type, working_directory
      FROM chat_sessions
      WHERE session_type = 'curator'
      ORDER BY id ASC
    `).all() as Array<{ id: string; title: string; session_type: string | null; working_directory: string | null }>;

    assert.deepStrictEqual(sessionRows, [{
      id: DEFAULT_CURATOR_CHAT_SESSION_ID,
      title: 'Curator Agent',
      session_type: 'curator',
      working_directory: process.cwd(),
    }]);
    assert.deepStrictEqual(
      (enqueuePayload?.metadata as Record<string, unknown> | undefined)?.heartbeatSessionResolution,
      {
        reusedSessionId: null,
        createdSessionId: DEFAULT_CURATOR_CHAT_SESSION_ID,
        workingDirectory: process.cwd(),
      },
    );
    assert.strictEqual(
      (enqueuePayload?.metadata as Record<string, unknown> | undefined)?.sessionId,
      DEFAULT_CURATOR_CHAT_SESSION_ID,
    );
  });

  test('evaluateAdaptiveHeartbeat skips if pending curation exists', async () => {
    const pendingId = `pending-${Date.now()}`;
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    insertCurationLogStart({
      requestId: pendingId,
      triggeredBy: 'unit-test-pending',
      startedAt: twoHoursAgo,
      feedCountBefore: 0,
    });

    const result = await evaluateAdaptiveHeartbeat({
      triggeredBy: 'unit-test-pending',
      latestActivity: {
        event: 'pull_refresh',
        timestamp: new Date().toISOString(),
      },
    });

    assert.strictEqual(result.triggered, false);
    assert.strictEqual(result.triggerReason, 'curation_cycle_pending');
    assert.strictEqual(result.requestId, null);
    assert.strictEqual(result.queueDepth, 0);
  });

  test('evaluateAdaptiveHeartbeat skips if queued curator /curate chat exists without a curation log row', async () => {
    const curatorSession = createChatSession({
      sessionType: 'curator',
      title: 'Queued Curator Backstop',
      workingDirectory: process.cwd(),
    });

    insertChatMessage({
      id: `msg-backstop-${Date.now()}`,
      role: 'user',
      sessionId: curatorSession.id,
      text: '/curate',
      status: 'queued',
      timestamp: new Date().toISOString(),
    });

    const result = await evaluateAdaptiveHeartbeat({
      triggeredBy: 'unit-test-chat-backstop',
      latestActivity: {
        event: 'pull_refresh',
        timestamp: new Date().toISOString(),
      },
    });

    assert.strictEqual(result.triggered, false);
    assert.strictEqual(result.triggerReason, 'curation_cycle_pending');
    assert.strictEqual(result.requestId, null);
  });

  test('evaluateAdaptiveHeartbeat skips when automatic curation is disabled in config', async () => {
    await fs.promises.writeFile(path.join(tempDir, 'config.md'), [
      '# Evogent Config',
      '',
      '## Usage Level',
      'Medium',
      '',
      '## Automatic Curation',
      'Off',
      '',
    ].join('\n'), 'utf8');

    const result = await evaluateAdaptiveHeartbeat({
      triggeredBy: 'unit-test-disabled',
      latestActivity: {
        event: 'pull_refresh',
        timestamp: new Date().toISOString(),
      },
    });

    assert.strictEqual(result.triggered, false);
    assert.strictEqual(result.triggerReason, 'automatic_curation_disabled');
    assert.strictEqual(result.requestId, null);
    assert.strictEqual(result.queueDepth, 0);
  });

  test('completeAdaptiveHeartbeat sets completed_at and items_added', () => {
    const requestId = `complete-${Date.now()}`;

    insertCurationLogStart({
      requestId,
      triggeredBy: 'unit-test-complete',
      startedAt: '2026-03-01T10:00:00.000Z',
      feedCountBefore: 0,
    });

    const db = getDb();
    const now = new Date().toISOString();
    db.prepare('INSERT INTO feed (id, type, text, published_at) VALUES (?, ?, ?, ?)').run(
      `feed-${Date.now()}-1`,
      'article',
      'first',
      now,
    );
    db.prepare('INSERT INTO feed (id, type, text, published_at) VALUES (?, ?, ?, ?)').run(
      `feed-${Date.now()}-2`,
      'tweet',
      'second',
      now,
    );

    const completed = completeAdaptiveHeartbeat(requestId);
    assert.strictEqual(completed, true);

    const entry = getCurationLogByRequestId(requestId);
    assert.ok(entry);
    assert.strictEqual(typeof entry?.completedAt, 'string');
    assert.ok((entry?.completedAt ?? '').length > 0);
    assert.strictEqual(entry?.itemsAdded, 2);
    assert.strictEqual(entry?.completionStatus, 'success');
  });

  test('latest successful curation ignores cancelled zero-item run in max-interval timeline', () => {
    insertCurationLogStart({
      requestId: 'timeline-success-1921',
      triggeredBy: 'adaptive_heartbeat:timer:max_interval_elapsed',
      startedAt: '2026-04-26T19:21:20.000Z',
      feedCountBefore: 1990,
    });
    completeCurationLogByRequestId('timeline-success-1921', {
      completedAt: '2026-04-26T19:21:22.000Z',
      itemsAdded: 6,
      completionStatus: 'success',
    });

    insertCurationLogStart({
      requestId: 'timeline-cancelled-2238',
      triggeredBy: 'adaptive_heartbeat:activity:app_open:app_open_auto',
      startedAt: '2026-04-26T22:38:12.000Z',
      feedCountBefore: 1990,
    });
    completeCurationLogByRequestId('timeline-cancelled-2238', {
      completedAt: '2026-04-26T22:38:17.955Z',
      itemsAdded: 0,
      completionStatus: 'cancelled',
      completionReason: 'chat message was cancelled before curation output',
    });

    assert.strictEqual(getLatestSuccessfulCurationTime(), '2026-04-26T19:21:22.000Z');

    const decision = getTriggerDecision({
      now: '2026-04-27T01:22:00.000Z',
      lastCurationAt: getLatestSuccessfulCurationTime(),
      activityHistory: [],
      minIntervalMinutes: 120,
      maxIntervalMinutes: 360,
    });

    assert.strictEqual(decision.trigger, true);
    assert.strictEqual(decision.reason, 'max_interval_elapsed');
  });

  test('explicit successful empty curation can reset the heartbeat clock', () => {
    insertCurationLogStart({
      requestId: 'timeline-success-1900',
      triggeredBy: 'adaptive_heartbeat:timer:max_interval_elapsed',
      startedAt: '2026-04-26T19:00:00.000Z',
      feedCountBefore: 10,
    });
    completeCurationLogByRequestId('timeline-success-1900', {
      completedAt: '2026-04-26T19:05:00.000Z',
      itemsAdded: 3,
      completionStatus: 'success',
    });

    insertCurationLogStart({
      requestId: 'timeline-empty-2200',
      triggeredBy: 'adaptive_heartbeat:timer:max_interval_elapsed',
      startedAt: '2026-04-26T22:00:00.000Z',
      feedCountBefore: 13,
    });
    completeCurationLogByRequestId('timeline-empty-2200', {
      completedAt: '2026-04-26T22:02:00.000Z',
      itemsAdded: 0,
      completionStatus: 'successful_empty',
      completionReason: 'curator completed and found no new items',
    });

    assert.strictEqual(getLatestSuccessfulCurationTime(), '2026-04-26T22:02:00.000Z');
  });

  test('failed zero-item curation does not reset the heartbeat clock', () => {
    insertCurationLogStart({
      requestId: 'failed-clock-success',
      triggeredBy: 'adaptive_heartbeat:timer:max_interval_elapsed',
      startedAt: '2026-04-26T19:00:00.000Z',
      feedCountBefore: 10,
    });
    completeCurationLogByRequestId('failed-clock-success', {
      completedAt: '2026-04-26T19:05:00.000Z',
      itemsAdded: 1,
      completionStatus: 'success',
    });

    insertCurationLogStart({
      requestId: 'failed-clock-zero',
      triggeredBy: 'adaptive_heartbeat:timer:max_interval_elapsed',
      startedAt: '2026-04-26T22:00:00.000Z',
      feedCountBefore: 11,
    });
    completeCurationLogByRequestId('failed-clock-zero', {
      completedAt: '2026-04-26T22:01:00.000Z',
      itemsAdded: 0,
      completionStatus: 'failed',
      completionReason: 'rate limited before curation output',
    });

    assert.strictEqual(getLatestSuccessfulCurationTime(), '2026-04-26T19:05:00.000Z');
  });
});
