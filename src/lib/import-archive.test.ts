import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { getDb } from '@/lib/db/client';
import { importTwitterArchive } from '@/lib/import-archive';

const originalDataDir = process.env.DATA_DIR;
const originalDbPath = process.env.MEDIA_AGENT_DB_PATH;

let tempDir = '';

function resetDbHandle() {
  if (global.evogentDb) {
    global.evogentDb.close();
    global.evogentDb = undefined;
  }
}

beforeEach(async () => {
  tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evogent-import-archive-test-'));
  process.env.DATA_DIR = tempDir;
  process.env.MEDIA_AGENT_DB_PATH = path.join(tempDir, 'media-agent.db');
  resetDbHandle();
});

afterEach(async () => {
  resetDbHandle();
  if (originalDataDir === undefined) {
    delete process.env.DATA_DIR;
  } else {
    process.env.DATA_DIR = originalDataDir;
  }
  if (originalDbPath === undefined) {
    delete process.env.MEDIA_AGENT_DB_PATH;
  } else {
    process.env.MEDIA_AGENT_DB_PATH = originalDbPath;
  }
  if (tempDir) {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

test('importTwitterArchive imports following and bookmarks from archive directories', async () => {
  const archiveRoot = path.join(tempDir, 'archive');
  const dataDir = path.join(archiveRoot, 'data');
  await fs.promises.mkdir(dataDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(dataDir, 'following.js'),
    'window.YTD.following.part0 = [{"following":{"accountId":"42","userLink":"https://x.com/example"}}];',
    'utf8',
  );
  await fs.promises.writeFile(
    path.join(dataDir, 'bookmarks.js'),
    'window.YTD.bookmarks.part0 = [{"bookmark":{"tweetId":"1900000000000000000","fullText":"Saved thread"}}];',
    'utf8',
  );

  const result = await importTwitterArchive(archiveRoot);

  assert.strictEqual(result.following.found, 1);
  assert.strictEqual(result.following.imported, 1);
  assert.strictEqual(result.bookmarks.found, 1);
  assert.strictEqual(result.bookmarks.imported, 1);

  const db = getDb();
  const rows = db.prepare(`
    SELECT source, signal_type AS signalType, text
    FROM preferences
    ORDER BY source ASC
  `).all() as Array<{ source: string; signalType: string; text: string }>;

  assert.deepStrictEqual(rows, [
    {
      source: 'twitter_archive_bookmark',
      signalType: 'liked',
      text: 'Saved thread',
    },
    {
      source: 'twitter_archive_following',
      signalType: 'explicit',
      text: 'Follows account: https://x.com/example',
    },
  ]);
});
