import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, test } from 'node:test';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const {
  enqueueCacheRefreshForCuration,
  resolvePreCurationFreshCacheMaxAgeMs,
  waitForCacheRefreshSources,
} = require('../lib/cache-refresh-on-demand.js');

const tempRoots = [];

async function createRoot() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evogent-cache-refresh-'));
  tempRoots.push(rootDir);
  await fs.mkdir(path.join(rootDir, '.claude', 'skills', 'tweet-cache'), { recursive: true });
  await fs.mkdir(path.join(rootDir, 'data'), { recursive: true });
  await fs.writeFile(path.join(rootDir, '.claude', 'skills', 'tweet-cache', 'SKILL.md'), '# Tweet cache\n');
  await fs.writeFile(path.join(rootDir, 'data', 'config.md'), [
    '# Evogent Config',
    '',
    '## Usage Level',
    'Medium',
    '',
    '## Background Source Browsing',
    'On',
    '',
  ].join('\n'));

  const db = new Database(path.join(rootDir, 'data', 'media-agent.db'));
  db.exec(`
    CREATE TABLE browse_cache_refresh_runs (
      id TEXT PRIMARY KEY,
      source TEXT,
      status TEXT,
      error TEXT,
      started_at_ms INTEGER,
      completed_at_ms INTEGER,
      triggered_by TEXT
    );
  `);
  db.close();
  return rootDir;
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const rootDir = tempRoots.pop();
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

describe('pre-curation cache refresh orchestration', () => {
  test('skips queueing and waiting when a source refresh is still fresh', async () => {
    const rootDir = await createRoot();
    const db = new Database(path.join(rootDir, 'data', 'media-agent.db'));
    const now = Date.now();
    db.prepare(`
      INSERT INTO browse_cache_refresh_runs
        (id, source, status, error, started_at_ms, completed_at_ms, triggered_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('twitter-recent-run', 'twitter', 'completed', null, now - 60_000, now - 30_000, 'cache_refresh');
    db.close();

    const result = await enqueueCacheRefreshForCuration({
      id: 'curation-proof',
      priority: 'heartbeat',
      message: '/curate',
      metadata: {
        automatedCuration: true,
        curationCommand: '/curate',
      },
    }, {
      rootDir,
      configPath: path.join(rootDir, 'data', 'config.md'),
      timeoutMs: 20,
      waitForCompletion: true,
    });

    assert.deepStrictEqual(result.queuedSources, []);
    assert.deepStrictEqual(result.waitedSources, []);
    assert.strictEqual(result.timedOut, false);
    assert.strictEqual(result.sourceResults.length, 1);
    assert.strictEqual(result.sourceResults[0].source, 'twitter');
    assert.strictEqual(result.sourceResults[0].action, 'skipped_fresh');
    assert.strictEqual(result.sourceResults[0].result, 'fresh');
    assert.strictEqual(result.sourceResults[0].runId, 'twitter-recent-run');
  });

  test('derives freshness from the source policy and usage level', async () => {
    const rootDir = await createRoot();
    assert.strictEqual(
      resolvePreCurationFreshCacheMaxAgeMs('twitter', rootDir, path.join(rootDir, 'data', 'config.md')),
      7.5 * 60 * 60 * 1000,
    );
  });

  test('wait loop accepts a completed DB run even if the queue still reports pending', async () => {
    const rootDir = await createRoot();
    const startedAtMs = Date.now();
    const dbPath = path.join(rootDir, 'data', 'media-agent.db');

    setTimeout(() => {
      const db = new Database(dbPath);
      try {
        db.prepare(`
          INSERT INTO browse_cache_refresh_runs
            (id, source, status, error, started_at_ms, completed_at_ms, triggered_by)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run('twitter-completed-after-wait', 'twitter', 'completed', null, startedAtMs + 5, startedAtMs + 10, 'cache_refresh');
      } finally {
        db.close();
      }
    }, 15);

    const result = await waitForCacheRefreshSources(['twitter'], {
      rootDir,
      completedAfterMs: startedAtMs,
      timeoutMs: 250,
      pollIntervalMs: 10,
      isPendingCacheRefreshJob: async () => true,
    });

    assert.strictEqual(result.timedOut, false);
    assert.deepStrictEqual(result.pendingSources, []);
  });
});
