import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

const require = createRequire(import.meta.url);
const {
  hasCurationCapability,
  hasCuratorChatSession,
} = require('../lib/cache-refresh-config.js');

const ENV_KEYS = ['DATA_DIR', 'MEDIA_AGENT_DB_PATH', 'TEST_SERVER_DATA_DIR'];

function withCleanCurationEnv(fn) {
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }

  try {
    fn();
  } finally {
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test('hasCurationCapability is false with no curator session and no source skills', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-curation-capability-empty-'));
  try {
    withCleanCurationEnv(() => {
      assert.strictEqual(hasCurationCapability(tempDir), false);
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('hasCurationCapability is true when a source skill is installed', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-curation-capability-source-'));
  try {
    fs.mkdirSync(path.join(tempDir, '.claude', 'skills', 'hackernews-cache'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, '.claude', 'skills', 'hackernews-cache', 'SKILL.md'), '# Hacker News Cache\n', 'utf8');

    withCleanCurationEnv(() => {
      assert.strictEqual(hasCurationCapability(tempDir), true);
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('hasCurationCapability detects a curator chat session in media-agent.db', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-curation-capability-db-'));
  const dataDir = path.join(tempDir, 'data');
  const dbPath = path.join(dataDir, 'media-agent.db');
  fs.mkdirSync(dataDir, { recursive: true });

  const db = new Database(dbPath);
  try {
    db.exec('CREATE TABLE chat_sessions (id TEXT PRIMARY KEY, session_type TEXT)');
    db.prepare('INSERT INTO chat_sessions (id, session_type) VALUES (?, ?)').run('curator-session', 'curator');
  } finally {
    db.close();
  }

  try {
    withCleanCurationEnv(() => {
      process.env.DATA_DIR = dataDir;
      assert.strictEqual(hasCuratorChatSession(dbPath), true);
      assert.strictEqual(hasCurationCapability(tempDir), true);
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
