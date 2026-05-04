import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import Database from 'better-sqlite3';
import { createChatSession } from '../src/lib/db/chat-sessions';
import { getDb } from '../src/lib/db/client';
import { requireValidationIsolationContext } from './integration-fixture-helpers';

type GlobalWithDb = typeof globalThis & { evogentDb?: Database.Database };

const globalWithDb = globalThis as GlobalWithDb;
const envKeys = ['DATA_DIR', 'MEDIA_AGENT_DB_PATH', 'TEST_SERVER_DATA_DIR', 'TEST_SERVER_URL', 'TEST_SERVER_WS_URL'] as const;
const tempDirs: string[] = [];
let originalEnv: Partial<Record<(typeof envKeys)[number], string>> = {};

function closeGlobalDb(): void {
  globalWithDb.evogentDb?.close();
  delete globalWithDb.evogentDb;
}

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function countChatSessions(dbPath: string): number {
  const db = new Database(dbPath);
  try {
    return (db.prepare('SELECT COUNT(*) AS count FROM chat_sessions').get() as { count: number }).count;
  } finally {
    db.close();
  }
}

beforeEach(() => {
  closeGlobalDb();
  originalEnv = {};
  for (const key of envKeys) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  closeGlobalDb();
  for (const key of envKeys) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('integration guard aborts before chat fixtures insert rows when isolation env is missing', () => {
  process.env.MEDIA_AGENT_DB_PATH = path.join(tempDir('evogent-integration-guard-'), 'media-agent.db');

  const db = getDb();
  const before = (db.prepare('SELECT COUNT(*) AS count FROM chat_sessions').get() as { count: number }).count;

  assert.throws(
    () => requireValidationIsolationContext('API integration tests'),
    /TEST_SERVER_URL.*TEST_SERVER_DATA_DIR.*DATA_DIR/s,
  );
  assert.strictEqual(
    (db.prepare('SELECT COUNT(*) AS count FROM chat_sessions').get() as { count: number }).count,
    before,
  );
});

test('direct DB setup uses TEST_SERVER_DATA_DIR and leaves production data unchanged', () => {
  const productionDbPath = path.join(tempDir('evogent-production-db-'), 'media-agent.db');
  const isolatedDataDir = tempDir('evogent-isolated-validation-');
  const isolatedDbPath = path.join(isolatedDataDir, 'media-agent.db');

  process.env.MEDIA_AGENT_DB_PATH = productionDbPath;
  createChatSession({ title: 'Production sentinel' });
  closeGlobalDb();
  const productionCountBefore = countChatSessions(productionDbPath);

  delete process.env.MEDIA_AGENT_DB_PATH;
  process.env.TEST_SERVER_URL = 'http://127.0.0.1:3138';
  process.env.TEST_SERVER_DATA_DIR = isolatedDataDir;

  const context = requireValidationIsolationContext('API integration tests');
  assert.strictEqual(context.dataDir, isolatedDataDir);
  createChatSession({ title: 'Isolated validation session' });
  closeGlobalDb();

  assert.strictEqual(countChatSessions(productionDbPath), productionCountBefore);
  assert.strictEqual(countChatSessions(isolatedDbPath), 1);
});
