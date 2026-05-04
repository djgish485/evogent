import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import Database from 'better-sqlite3';

type GlobalWithDb = typeof globalThis & {
  evogentDb?: Database.Database;
};

async function importClientModule() {
  return import('./client');
}

describe('getDb', () => {
  test('does not cache a failed initialization attempt', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-db-client-'));
    const dbPath = path.join(tempDir, 'media-agent.db');
    const dataDir = path.join(tempDir, 'data');
    const globalWithDb = global as GlobalWithDb;
    const originalDbPath = process.env.MEDIA_AGENT_DB_PATH;
    const originalDataDir = process.env.DATA_DIR;

    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'config.md'), '# Evogent Config\n');

    const seededDb = new Database(dbPath);
    seededDb.exec(`
      CREATE VIEW browse_cache_items AS
      SELECT 'twitter' AS source, 1 AS expires_at_ms;
    `);
    seededDb.close();

    process.env.MEDIA_AGENT_DB_PATH = dbPath;
    process.env.DATA_DIR = dataDir;

    const { getDb } = await importClientModule();

    try {
      assert.throws(() => {
        getDb();
      }, /views may not be indexed/);
      assert.strictEqual(globalWithDb.evogentDb, undefined);

      const repairDb = new Database(dbPath);
      repairDb.exec('DROP VIEW browse_cache_items;');
      repairDb.close();

      const db = getDb();
      const tables = new Set((db.prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
      `).all() as Array<{ name: string }>).map((row) => row.name));

      assert.ok(tables.has('browse_cache_items'));
      assert.ok(tables.has('browse_cache_refresh_runs'));
    } finally {
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
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
