import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getDefaultDbPath } from '@/lib/data-dir';
import { ensureFeedSchema } from './schema';
import { cleanupKnownValidationFixtures } from './validation-fixtures';

const require = createRequire(import.meta.url);
let vectorExtensionAvailable = false;

declare global {
  var evogentDb: Database.Database | undefined;
}

export function getDbPath(): string {
  const testServerDataDir = process.env.TEST_SERVER_DATA_DIR?.trim();
  if (testServerDataDir) {
    return path.join(path.resolve(testServerDataDir), 'media-agent.db');
  }

  return process.env.MEDIA_AGENT_DB_PATH || getDefaultDbPath();
}

export function isVectorExtensionAvailable(): boolean {
  return vectorExtensionAvailable;
}

export function getDb(): Database.Database {
  if (!global.evogentDb) {
    const dbPath = getDbPath();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    let localVectorExtensionAvailable = false;

    try {
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = NORMAL');
      try {
        const sqliteVec = require('sqlite-vec') as { load: (db: Database.Database) => void };
        sqliteVec.load(db);
        localVectorExtensionAvailable = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[db] sqlite-vec extension unavailable, vector features disabled: ${message}`);
      }

      ensureFeedSchema(db);

      const cleanupResult = cleanupKnownValidationFixtures(db);
      if (cleanupResult.deletedFeedRows > 0) {
        console.warn(
          `[db] cleaned ${cleanupResult.deletedFeedRows} validation fixture feed rows `
          + `(${cleanupResult.deletedInteractionRows} interactions, `
          + `${cleanupResult.deletedPreferenceRows} preferences, `
          + `${cleanupResult.deletedCodeFixTaskRows} code_fix_tasks)`,
        );
      }

      if (localVectorExtensionAvailable) {
        try {
          db.exec(`
            CREATE VIRTUAL TABLE IF NOT EXISTS pref_vec USING vec0(
              id TEXT PRIMARY KEY,
              embedding float[384]
            );
          `);
        } catch (error) {
          localVectorExtensionAvailable = false;
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`[db] Failed to initialize pref_vec table, vector features disabled: ${message}`);
        }
      }

      global.evogentDb = db;
      vectorExtensionAvailable = localVectorExtensionAvailable;
    } catch (error) {
      vectorExtensionAvailable = false;
      db.close();
      throw error;
    }
  }

  return global.evogentDb;
}
