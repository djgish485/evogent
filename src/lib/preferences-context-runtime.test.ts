import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, test } from 'node:test';
import Database from 'better-sqlite3';
import { ensureFeedSchema } from '@/lib/db/schema';

type PreferenceContextRuntimeModule = {
  regeneratePreferenceContext: () => Promise<string>;
};

describe('preferences-context-runtime', { concurrency: false }, () => {
  let originalCwd = '';
  let originalDataDir: string | undefined;
  let originalDbPath: string | undefined;
  let tempDir = '';

  beforeEach(async () => {
    originalCwd = process.cwd();
    originalDataDir = process.env.DATA_DIR;
    originalDbPath = process.env.MEDIA_AGENT_DB_PATH;
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evogent-pref-context-'));
    await fs.promises.mkdir(path.join(tempDir, 'data'), { recursive: true });
    process.chdir(tempDir);
    process.env.DATA_DIR = path.join(tempDir, 'data');
    process.env.MEDIA_AGENT_DB_PATH = path.join(tempDir, 'data', 'media-agent.db');
  });

  afterEach(async () => {
    process.chdir(originalCwd);
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

  test('includes agent reasons alongside recent engagement reactions and truncates long reasons', async () => {
    const db = new Database(process.env.MEDIA_AGENT_DB_PATH!);
    try {
      ensureFeedSchema(db);

      db.prepare(`
        INSERT INTO feed (
          id, type, text, author_username, reason, published_at
        ) VALUES (
          @id, 'tweet', @text, @author_username, @reason, @published_at
        )
      `).run({
        id: 'feed-liked-1',
        text: 'Karpathy on where LLM world knowledge actually comes from.',
        author_username: 'karpathy',
        reason: 'Sharp technical insight on LLM knowledge gaps and how pretraining and retrieval differ in practice.',
        published_at: '2026-03-08T12:00:00.000Z',
      });

      db.prepare(`
        INSERT INTO feed (
          id, type, text, author_username, reason, published_at
        ) VALUES (
          @id, 'tweet', @text, @author_username, @reason, @published_at
        )
      `).run({
        id: 'feed-disliked-1',
        text: 'Statement from foreign minister on negotiations.',
        author_username: 'araghchi',
        reason: 'Iranian FM response to US policy',
        published_at: '2026-03-08T11:00:00.000Z',
      });

      db.prepare(`
        INSERT INTO feed (
          id, type, text, author_username, published_at
        ) VALUES (
          @id, 'tweet', @text, @author_username, @published_at
        )
      `).run({
        id: 'feed-liked-2',
        text: 'Older item without a curation reason.',
        author_username: 'noreason',
        published_at: '2026-03-08T10:00:00.000Z',
      });

      db.prepare(`
        INSERT INTO preferences (
          id, feed_item_id, signal_type, source, text, author_username, created_at
        ) VALUES (
          @id, @feed_item_id, @signal_type, @source, @text, @author_username, @created_at
        )
      `).run({
        id: 'pref-liked-1',
        feed_item_id: 'feed-liked-1',
        signal_type: 'liked',
        source: 'app_thumbsup',
        text: 'Karpathy on where LLM world knowledge actually comes from.',
        author_username: 'karpathy',
        created_at: '2026-03-08T12:05:00.000Z',
      });

      db.prepare(`
        INSERT INTO preferences (
          id, feed_item_id, signal_type, source, text, reason, author_username, created_at
        ) VALUES (
          @id, @feed_item_id, @signal_type, @source, @text, @reason, @author_username, @created_at
        )
      `).run({
        id: 'pref-disliked-1',
        feed_item_id: 'feed-disliked-1',
        signal_type: 'disliked',
        source: 'app_thumbsdown',
        text: 'Statement from foreign minister on negotiations.',
        reason: 'Who is this',
        author_username: 'araghchi',
        created_at: '2026-03-08T12:04:00.000Z',
      });

      db.prepare(`
        INSERT INTO preferences (
          id, feed_item_id, signal_type, source, text, author_username, created_at
        ) VALUES (
          @id, @feed_item_id, @signal_type, @source, @text, @author_username, @created_at
        )
      `).run({
        id: 'pref-liked-2',
        feed_item_id: 'feed-liked-2',
        signal_type: 'liked',
        source: 'app_thumbsup',
        text: 'Older item without a curation reason.',
        author_username: 'noreason',
        created_at: '2026-03-08T12:03:00.000Z',
      });
    } finally {
      db.close();
    }

    const runtimeModuleUrl = `${pathToFileURL(path.join(originalCwd, 'src/lib/preferences-context-runtime.js')).href}?t=${Date.now()}`;
    const imported = await import(runtimeModuleUrl);
    const runtime = ((imported.default as PreferenceContextRuntimeModule | undefined) ?? imported) as PreferenceContextRuntimeModule;
    const writtenPath = await runtime.regeneratePreferenceContext();
    const markdown = await fs.promises.readFile(writtenPath, 'utf8');

    assert.match(
      markdown,
      /\[LIKED\] @karpathy: "Karpathy on where LLM world knowledge actually comes from\." \(agent reason: "Sharp technical insight on LLM knowledge gaps and how pretraining and retrieval differ \.\.\."\)/,
    );
    assert.match(
      markdown,
      /\[DISLIKED\] @araghchi: "Statement from foreign minister on negotiations\." \(agent reason: "Iranian FM response to US policy"\) \(user said: "Who is this"\)/,
    );

    const noReasonLine = markdown
      .split('\n')
      .find((line) => line.includes('@noreason: "Older item without a curation reason."'));
    assert.ok(noReasonLine);
    assert.doesNotMatch(noReasonLine!, /agent reason:/);
  });
});
