import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { getDb } from '@/lib/db/client';
import type { FeedItem } from '@/types/feed';

type GlobalWithDb = typeof globalThis & {
  evogentDb?: {
    close: () => void;
  };
};

const globalWithDb = globalThis as GlobalWithDb;

function sourceSetupItem(source: string, sourcePackage: string): FeedItem {
  return {
    id: `source-setup-${source}`,
    type: 'suggestion',
    source: 'phone',
    sourceId: `source-setup-${source}`,
    title: 'Source setup',
    text: 'Source setup',
    metadata: {
      sourceName: source,
      sourcePackage,
    },
  } as unknown as FeedItem;
}

test('source cancellation validates ledger fields and keeps the DB tombstone authoritative', {
  concurrency: false,
}, async () => {
  const originalCwd = process.cwd();
  const originalDbPath = process.env.MEDIA_AGENT_DB_PATH;
  const originalDataDir = process.env.DATA_DIR;
  const tempDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'evogent-source-setup-test-'),
  );
  try {
    process.chdir(tempDir);
    process.env.DATA_DIR = path.join(tempDir, 'data');
    process.env.MEDIA_AGENT_DB_PATH = path.join(tempDir, 'media-agent.db');
    const { cancelSourceSetup } = await import('./source-setup');

    const injected = cancelSourceSetup(sourceSetupItem(
      'safe-source',
      'com.example.safe\nother-source com.example.other',
    ));
    assert.deepEqual(injected, { cancelled: false, source: null });
    assert.equal(fs.existsSync(path.join(tempDir, 'data', 'phone-sources', '.optout')), false);

    const sourceRoot = path.join(tempDir, 'data', 'phone-sources');
    fs.mkdirSync(path.join(sourceRoot, '.queue'), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, 'safe-source.txt'), 'old recipe\n');
    fs.writeFileSync(path.join(sourceRoot, '.queue', 'safe-source.json'), '{}\n');
    const cancelled = cancelSourceSetup(
      sourceSetupItem('safe-source', 'com.example.safe'),
    );
    assert.deepEqual(cancelled, { cancelled: true, source: 'safe-source' });
    assert.equal(
      fs.readFileSync(path.join(sourceRoot, '.optout'), 'utf8'),
      'safe-source com.example.safe\n',
    );
    assert.equal(fs.existsSync(path.join(sourceRoot, 'safe-source.txt')), false);
    assert.deepEqual(
      getDb().prepare(`
        SELECT source
        FROM browse_cache_source_optouts
        WHERE source = ?
      `).get('safe-source'),
      { source: 'safe-source' },
    );

    // Make every filesystem cleanup operation fail after the database transaction. The owner
    // cancellation still succeeds because the tombstone is the activation/admission authority.
    fs.rmSync(sourceRoot, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(sourceRoot), { recursive: true });
    fs.writeFileSync(sourceRoot, 'not a directory\n');
    const cleanupFailure = cancelSourceSetup(
      sourceSetupItem('second-source', 'com.example.second'),
    );
    assert.deepEqual(cleanupFailure, { cancelled: true, source: 'second-source' });
    assert.deepEqual(
      getDb().prepare(`
        SELECT source
        FROM browse_cache_source_optouts
        WHERE source = ?
      `).get('second-source'),
      { source: 'second-source' },
    );
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
    process.chdir(originalCwd);
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});
