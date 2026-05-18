import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { evaluateAdaptiveHeartbeat, completeAdaptiveHeartbeat } from './heartbeat-service';
import { getTriggerDecision } from './heartbeat';
import { getDb } from './db/client';
import { insertChatMessage } from './db/chat';
import { createChatSession } from './db/chat-sessions';
import {
  completeCurationLogByRequestId,
  getCurationLogByRequestId,
  getLatestSuccessfulCurationTime,
  insertCurationLogStart,
} from './db/activity';

type GlobalWithDb = typeof globalThis & {
  evogentDb?: {
    close: () => void;
  };
};

const globalWithDb = globalThis as GlobalWithDb;

describe('heartbeat service', () => {
  let originalDbPath: string | undefined;
  let originalDataDir: string | undefined;
  let originalSkillsDir: string | undefined;
  let originalEvogentRoot: string | undefined;
  let originalInternalBaseUrl: string | undefined;
  let originalPath: string | undefined;
  let originalFetch: typeof fetch;
  let tempDir = '';
  let openClawPayload: Record<string, unknown> | null = null;
  let openClawUrl: string | null = null;

  beforeEach(async () => {
    originalDbPath = process.env.MEDIA_AGENT_DB_PATH;
    originalDataDir = process.env.DATA_DIR;
    originalSkillsDir = process.env.MEDIA_AGENT_SKILLS_DIR;
    originalEvogentRoot = process.env.MEDIA_AGENT_ROOT;
    originalInternalBaseUrl = process.env.MEDIA_AGENT_INTERNAL_BASE_URL;
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

## Background Source Browsing
Off

## Curation Schedule
- Minimum interval: 1 minute
- Maximum interval: 1 minute
`, 'utf8');
    process.env.MEDIA_AGENT_INTERNAL_BASE_URL = 'http://evogent.test';
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`;
    openClawPayload = null;
    openClawUrl = null;
    globalThis.fetch = (async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if (url.endsWith('/api/openclaw/chat/agent%3Acurator%3Amain')) {
        const payload = init?.body && typeof init.body === 'string'
          ? JSON.parse(init.body) as { requestId?: string }
          : {};
        openClawPayload = payload as Record<string, unknown>;
        openClawUrl = url;

        return new Response(JSON.stringify({
          ok: true,
          sessionKey: 'agent:curator:main',
          sessionId: 'openclaw:agent:curator:main',
          runId: payload.requestId ?? `heartbeat-test-${Date.now()}`,
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

    if (originalInternalBaseUrl === undefined) {
      delete process.env.MEDIA_AGENT_INTERNAL_BASE_URL;
    } else {
      process.env.MEDIA_AGENT_INTERNAL_BASE_URL = originalInternalBaseUrl;
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

  test('evaluateAdaptiveHeartbeat posts a full curation request to the OpenClaw curator session', async () => {
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
    assert.ok((result.requestId ?? '').startsWith('openclaw-heartbeat-'));
    assert.strictEqual(result.queueDepth, 1);
    assert.ok(openClawUrl?.endsWith('/api/openclaw/chat/agent%3Acurator%3Amain'));
    assert.ok(openClawPayload);
    assert.strictEqual(openClawPayload?.message, 'Run a full curation cycle now.');
    assert.strictEqual(openClawPayload?.idempotencyKey, result.requestId);

    const curationLogEntry = getCurationLogByRequestId(result.requestId as string);
    assert.ok(curationLogEntry);
    assert.strictEqual(curationLogEntry?.requestId, result.requestId);
    assert.strictEqual(curationLogEntry?.completedAt, null);
    assert.strictEqual(curationLogEntry?.triggeredBy, 'adaptive_heartbeat:unit-test:pull_refresh_immediate');
  });

  test('evaluateAdaptiveHeartbeat deduplicates rapid app-open auto-curate requests', async () => {
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

    openClawPayload = null;
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
    assert.strictEqual(openClawPayload, null);
    assert.ok(getCurationLogByRequestId(firstResult.requestId as string));
  });

  test('evaluateAdaptiveHeartbeat treats automated cancellation as a scheduler cooldown shared by timer and cron', async () => {
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

    completeCurationLogByRequestId(timerResult.requestId as string, {
      completedAt: new Date().toISOString(),
      itemsAdded: 0,
      completionStatus: 'cancelled',
      completionReason: 'OpenClaw curation was cancelled before output',
    });
    openClawPayload = null;

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
    assert.strictEqual(openClawPayload, null);
  });

  test('evaluateAdaptiveHeartbeat supports an explicit OpenClaw curator session key', async () => {
    const originalSessionKey = process.env.OPENCLAW_CURATOR_SESSION_KEY;
    process.env.OPENCLAW_CURATOR_SESSION_KEY = 'agent:curator:custom';
    try {
      globalThis.fetch = (async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        assert.ok(url.endsWith('/api/openclaw/chat/agent%3Acurator%3Acustom'));
        openClawUrl = url;
        openClawPayload = init?.body && typeof init.body === 'string'
          ? JSON.parse(init.body) as Record<string, unknown>
          : {};
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof fetch;

      const result = await evaluateAdaptiveHeartbeat({
        triggeredBy: 'unit-test-custom-session',
        latestActivity: {
          event: 'pull_refresh',
          timestamp: new Date().toISOString(),
        },
      });

      assert.strictEqual(result.triggered, true);
      assert.ok(openClawUrl?.endsWith('/api/openclaw/chat/agent%3Acurator%3Acustom'));
      assert.strictEqual(openClawPayload?.idempotencyKey, result.requestId);
    } finally {
      if (originalSessionKey === undefined) {
        delete process.env.OPENCLAW_CURATOR_SESSION_KEY;
      } else {
        process.env.OPENCLAW_CURATOR_SESSION_KEY = originalSessionKey;
      }
    }
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
