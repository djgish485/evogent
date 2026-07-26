import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { recordBrowseCacheRefresh } from '@/lib/db/browse-cache';
import { getDb } from '@/lib/db/client';
import { readPhoneHealth } from '@/lib/phone-health';

type GlobalWithDb = typeof globalThis & {
  evogentDb?: {
    close: () => void;
  };
};

const globalWithDb = globalThis as GlobalWithDb;

describe('phone health', { concurrency: false }, () => {
  let tempDir = '';
  let originalDbPath: string | undefined;
  let originalDataDir: string | undefined;
  let originalProfile: string | undefined;
  let originalProcRoot: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-phone-health-'));
    originalDbPath = process.env.MEDIA_AGENT_DB_PATH;
    originalDataDir = process.env.DATA_DIR;
    originalProfile = process.env.EVOGENT_RUNTIME_PROFILE;
    originalProcRoot = process.env.EVOGENT_PROC_ROOT;
    process.env.MEDIA_AGENT_DB_PATH = path.join(tempDir, 'media-agent.db');
    process.env.DATA_DIR = tempDir;
    process.env.EVOGENT_RUNTIME_PROFILE = 'phone';
    process.env.EVOGENT_PROC_ROOT = path.join(tempDir, 'proc');
    if (globalWithDb.evogentDb) {
      globalWithDb.evogentDb.close();
      delete globalWithDb.evogentDb;
    }
  });

  afterEach(() => {
    if (globalWithDb.evogentDb) {
      globalWithDb.evogentDb.close();
      delete globalWithDb.evogentDb;
    }
    if (originalDbPath === undefined) delete process.env.MEDIA_AGENT_DB_PATH;
    else process.env.MEDIA_AGENT_DB_PATH = originalDbPath;
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    if (originalProfile === undefined) delete process.env.EVOGENT_RUNTIME_PROFILE;
    else process.env.EVOGENT_RUNTIME_PROFILE = originalProfile;
    if (originalProcRoot === undefined) delete process.env.EVOGENT_PROC_ROOT;
    else process.env.EVOGENT_PROC_ROOT = originalProcRoot;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('reports integrity, control state, queues, and source freshness without Redis', () => {
    const nowMs = Date.parse('2026-07-25T20:00:00.000Z');
    writeProcessStat(process.pid, 424_242);
    fs.writeFileSync(path.join(tempDir, 'phone-control-status.json'), JSON.stringify({
      updatedAtMs: nowMs - 60_000,
      scheduler: {
        state: 'running',
        pid: process.pid,
        processStartTicks: 424_242,
        updatedAtMs: nowMs - 60_000,
      },
      watchdog: {
        state: 'running',
        pid: process.pid,
        processStartTicks: 424_242,
        updatedAtMs: nowMs - 60_000,
      },
      cycle: { state: 'completed' },
      sources: {
        twitter: {
          outcome: 'fresh',
          completedAtMs: Date.parse('2026-07-25T19:30:00.000Z'),
        },
      },
    }));
    fs.writeFileSync(path.join(tempDir, 'source-cadence.json'), JSON.stringify({
      twitter: { cadenceHours: 2 },
    }));
    const db = getDb();
    db.prepare(`
      INSERT INTO browse_cache_items (
        source, source_id, payload_json, fetched_at_ms, expires_at_ms
      ) VALUES ('twitter', 'health-item', '{}', ?, ?)
    `).run(nowMs - 30 * 60_000, nowMs + 60 * 60_000);

    const health = readPhoneHealth(nowMs);

    assert.strictEqual(health.ok, true);
    assert.strictEqual(health.runtime.profile, 'phone');
    assert.strictEqual(health.runtime.backgroundJobsDisabled, true);
    assert.strictEqual(health.runtime.adaptiveHeartbeatMode, 'signal');
    assert.strictEqual(health.database.result, 'ok');
    assert.strictEqual(health.queues?.onPhoneDevelopment, 0);
    assert.strictEqual(health.control.scheduler.live, true);
    assert.strictEqual(health.control.watchdog.live, true);
    assert.deepStrictEqual(health.sources.map((source) => ({
      source: source.source,
      state: source.state,
      lastOutcome: source.lastOutcome,
      lastOutcomeAt: source.lastOutcomeAt,
    })), [{
      source: 'twitter',
      state: 'healthy',
      lastOutcome: 'fresh',
      lastOutcomeAt: '2026-07-25T19:30:00.000Z',
    }]);
  });

  test('uses a completed zero-new refresh as freshness while retaining older item evidence', () => {
    const nowMs = Date.parse('2026-07-25T20:00:00.000Z');
    fs.writeFileSync(path.join(tempDir, 'source-cadence.json'), JSON.stringify({
      twitter: { cadenceHours: 2 },
    }));
    const db = getDb();
    const oldFetchedAtMs = nowMs - 12 * 60 * 60_000;
    db.prepare(`
      INSERT INTO browse_cache_items (
        source, source_id, payload_json, fetched_at_ms, expires_at_ms
      ) VALUES ('twitter', 'older-deduplicated-item', '{}', ?, ?)
    `).run(oldFetchedAtMs, nowMs + 60 * 60_000);
    const completedAtMs = nowMs - 20 * 60_000;
    recordBrowseCacheRefresh({
      runId: 'zero-new-completed',
      source: 'twitter',
      triggeredBy: 'phone-scheduled',
      startedAtMs: completedAtMs - 60_000,
      completedAtMs,
      status: 'completed',
      itemsAdded: 0,
      items: [],
    });

    const health = readPhoneHealth(nowMs);
    const twitter = health.sources.find((source) => source.source === 'twitter');

    assert.ok(twitter);
    assert.strictEqual(twitter.state, 'healthy');
    assert.strictEqual(twitter.itemCount, 1);
    assert.strictEqual(twitter.latestFetchedAt, new Date(oldFetchedAtMs).toISOString());
    assert.strictEqual(
      twitter.latestCompletedRefreshAt,
      new Date(completedAtMs).toISOString(),
    );
    assert.strictEqual(twitter.freshnessReferenceAt, new Date(completedAtMs).toISOString());
    assert.strictEqual(twitter.freshnessReferenceKind, 'completed_refresh');
    assert.strictEqual(twitter.ageMinutes, 20);
    assert.deepStrictEqual(twitter.latestRefresh, {
      status: 'completed',
      itemsAdded: 0,
      completedAt: new Date(completedAtMs).toISOString(),
      error: null,
    });
  });

  test('a newer failed run remains failed and cannot impersonate a completed freshness receipt', () => {
    const nowMs = Date.parse('2026-07-25T20:00:00.000Z');
    fs.writeFileSync(path.join(tempDir, 'source-cadence.json'), JSON.stringify({
      twitter: { cadenceHours: 2 },
    }));
    const completedAtMs = nowMs - 30 * 60_000;
    recordBrowseCacheRefresh({
      runId: 'prior-completed',
      source: 'twitter',
      triggeredBy: 'phone-scheduled',
      startedAtMs: completedAtMs - 60_000,
      completedAtMs,
      status: 'completed',
      itemsAdded: 0,
    });
    const failedAtMs = nowMs - 5 * 60_000;
    recordBrowseCacheRefresh({
      runId: 'newer-failed',
      source: 'twitter',
      triggeredBy: 'phone-scheduled',
      startedAtMs: failedAtMs - 60_000,
      completedAtMs: failedAtMs,
      status: 'failed',
      itemsAdded: 0,
      error: 'authenticated surface unavailable',
    });

    const health = readPhoneHealth(nowMs);
    const twitter = health.sources.find((source) => source.source === 'twitter');

    assert.ok(twitter);
    assert.strictEqual(twitter.state, 'mechanics_failed');
    assert.strictEqual(
      twitter.latestCompletedRefreshAt,
      new Date(completedAtMs).toISOString(),
    );
    assert.strictEqual(twitter.freshnessReferenceAt, new Date(completedAtMs).toISOString());
    assert.strictEqual(twitter.freshnessReferenceKind, 'completed_refresh');
    assert.deepStrictEqual(twitter.latestRefresh, {
      status: 'failed',
      itemsAdded: 0,
      completedAt: new Date(failedAtMs).toISOString(),
      error: 'authenticated surface unavailable',
    });
  });

  test('without any refresh receipt, item evidence remains separate and missing evidence is empty', () => {
    const nowMs = Date.parse('2026-07-25T20:00:00.000Z');
    fs.writeFileSync(path.join(tempDir, 'source-cadence.json'), JSON.stringify({
      twitter: { cadenceHours: 2 },
      substack: { cadenceHours: 4 },
    }));
    const oldFetchedAtMs = nowMs - 8 * 60 * 60_000;
    const db = getDb();
    db.prepare(`
      INSERT INTO browse_cache_items (
        source, source_id, payload_json, fetched_at_ms, expires_at_ms
      ) VALUES ('twitter', 'legacy-cache-only', '{}', ?, ?)
    `).run(oldFetchedAtMs, nowMs + 60 * 60_000);

    const health = readPhoneHealth(nowMs);
    const twitter = health.sources.find((source) => source.source === 'twitter');
    const substack = health.sources.find((source) => source.source === 'substack');

    assert.ok(twitter);
    assert.strictEqual(twitter.state, 'stale');
    assert.strictEqual(twitter.latestFetchedAt, new Date(oldFetchedAtMs).toISOString());
    assert.strictEqual(twitter.latestCompletedRefreshAt, null);
    assert.strictEqual(twitter.freshnessReferenceAt, new Date(oldFetchedAtMs).toISOString());
    assert.strictEqual(twitter.freshnessReferenceKind, 'cache_item');
    assert.strictEqual(twitter.latestRefresh, null);

    assert.ok(substack);
    assert.strictEqual(substack.state, 'empty');
    assert.strictEqual(substack.latestFetchedAt, null);
    assert.strictEqual(substack.latestCompletedRefreshAt, null);
    assert.strictEqual(substack.freshnessReferenceAt, null);
    assert.strictEqual(substack.freshnessReferenceKind, null);
    assert.strictEqual(substack.latestRefresh, null);
  });

  test('fails closed when a phone scheduler claims ownership with a dead pid', () => {
    writeProcessStat(process.pid, 424_242);

    fs.writeFileSync(path.join(tempDir, 'phone-control-status.json'), JSON.stringify({
      updatedAtMs: Date.now(),
      scheduler: {
        state: 'running',
        pid: 999_999_999,
        processStartTicks: 1,
        updatedAtMs: Date.now(),
      },
      watchdog: {
        state: 'running',
        pid: process.pid,
        processStartTicks: 424_242,
        updatedAtMs: Date.now(),
      },
      cycle: { state: 'completed' },
    }));

    const health = readPhoneHealth();

    assert.strictEqual(health.ok, false);
    assert.strictEqual(health.control.scheduler.live, false);
    assert.ok(health.criticalProblems.includes('scheduler_owner_not_live'));
  });

  test('fails closed when the independent watchdog is not live', () => {
    writeProcessStat(process.pid, 424_242);
    fs.writeFileSync(path.join(tempDir, 'phone-control-status.json'), JSON.stringify({
      updatedAtMs: Date.now(),
      scheduler: {
        state: 'running',
        pid: process.pid,
        processStartTicks: 424_242,
        updatedAtMs: Date.now(),
      },
      watchdog: {
        state: 'running',
        pid: 999_999_999,
        processStartTicks: 1,
        updatedAtMs: Date.now(),
      },
      cycle: { state: 'completed' },
    }));

    const health = readPhoneHealth();

    assert.strictEqual(health.ok, false);
    assert.strictEqual(health.control.watchdog.live, false);
    assert.ok(health.criticalProblems.includes('watchdog_owner_not_live'));
  });

  test('distinguishes a stale watchdog heartbeat from a dead process identity', () => {
    const nowMs = Date.parse('2026-07-25T20:00:00.000Z');
    writeProcessStat(process.pid, 424_242);
    fs.writeFileSync(path.join(tempDir, 'phone-control-status.json'), JSON.stringify({
      updatedAtMs: nowMs,
      scheduler: {
        state: 'running',
        pid: process.pid,
        processStartTicks: 424_242,
        updatedAtMs: nowMs,
      },
      watchdog: {
        state: 'running',
        pid: process.pid,
        processStartTicks: 424_242,
        updatedAtMs: nowMs - 4 * 60_000,
      },
      cycle: { state: 'completed' },
    }));

    const health = readPhoneHealth(nowMs);

    assert.strictEqual(health.ok, false);
    assert.strictEqual(health.control.watchdog.processIdentityLive, true);
    assert.strictEqual(health.control.watchdog.heartbeatFresh, false);
    assert.strictEqual(health.control.watchdog.live, false);
    assert.ok(health.criticalProblems.includes('watchdog_heartbeat_stale'));
    assert.ok(!health.criticalProblems.includes('watchdog_owner_not_live'));
  });

  test('does not treat a fresh stopped status as a live watchdog', () => {
    const nowMs = Date.parse('2026-07-25T20:00:00.000Z');
    writeProcessStat(process.pid, 424_242);
    fs.writeFileSync(path.join(tempDir, 'phone-control-status.json'), JSON.stringify({
      updatedAtMs: nowMs,
      scheduler: {
        state: 'running',
        pid: process.pid,
        processStartTicks: 424_242,
        updatedAtMs: nowMs,
      },
      watchdog: {
        state: 'stopped',
        pid: process.pid,
        processStartTicks: 424_242,
        updatedAtMs: nowMs,
      },
      cycle: { state: 'completed' },
    }));

    const health = readPhoneHealth(nowMs);

    assert.strictEqual(health.control.watchdog.processIdentityLive, true);
    assert.strictEqual(health.control.watchdog.heartbeatFresh, true);
    assert.strictEqual(health.control.watchdog.live, false);
    assert.ok(health.criticalProblems.includes('watchdog_owner_not_live'));
  });
});

function writeProcessStat(pid: number, startTicks: number): void {
  const directory = path.join(process.env.EVOGENT_PROC_ROOT!, String(pid));
  fs.mkdirSync(directory, { recursive: true });
  // Fields 3..21 are arbitrary test values; starttime is proc(5) field 22.
  fs.writeFileSync(
    path.join(directory, 'stat'),
    `${pid} (evogent test) S ${Array.from({ length: 18 }, () => '1').join(' ')} ${startTicks} 0\n`,
  );
}
