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
        text: 'A technical note on where model knowledge comes from.',
        author_username: 'technical_author',
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
        text: 'A routine public statement on negotiations.',
        author_username: 'public_official',
        reason: 'A generic policy response without enough context',
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
        text: 'A technical note on where model knowledge comes from.',
        author_username: 'technical_author',
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
        text: 'A routine public statement on negotiations.',
        reason: 'Insufficient context for this source',
        author_username: 'public_official',
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
      /\[LIKED\] source=app_thumbsup @technical_author: "A technical note on where model knowledge comes from\." itemReason="Sharp technical insight on LLM knowledge gaps and how pretraining and retrieval differ \.\.\." \(2026-03-08T12:05:00\.000Z\)/,
    );
    assert.match(
      markdown,
      /\[DISLIKED\] source=app_thumbsdown @public_official: "A routine public statement on negotiations\." userReason="Insufficient context for this source" itemReason="A generic policy response without enough context" \(2026-03-08T12:04:00\.000Z\)/,
    );

    const noReasonLine = markdown
      .split('\n')
      .find((line) => line.includes('@noreason: "Older item without a curation reason."'));
    assert.ok(noReasonLine);
    assert.doesNotMatch(noReasonLine!, /itemReason=/);
  });

  test('writes a deterministic bounded private profile while retaining raw evidence in SQLite', async () => {
    const db = new Database(process.env.MEDIA_AGENT_DB_PATH!);
    try {
      ensureFeedSchema(db);
      db.prepare(`
        INSERT INTO feed (
          id, type, source, title, text, author_username, published_at
        ) VALUES (
          'attention-item', 'article', 'unit-test', 'An article revisited carefully',
          'A long private body that remains in SQLite.', 'thoughtful_author', ?
        )
      `).run('2026-07-25T12:00:00.000Z');

      const insertPreference = db.prepare(`
        INSERT INTO preferences (
          id, feed_item_id, signal_type, source, text, reason, author_username, weight, created_at
        ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)
      `);
      db.transaction(() => {
        for (let index = 0; index < 220; index += 1) {
          insertPreference.run(
            `raw-pref-${index}`,
            index % 9 === 0 ? 'disliked' : 'liked',
            index % 9 === 0 ? 'app_thumbsdown' : 'app_thumbsup',
            `Private raw preference evidence ${index} ${'substantive '.repeat(30)}`,
            index % 9 === 0 ? `Reason ${index}` : null,
            `author_${index % 12}`,
            index % 9 === 0 ? 1.5 : 1.2,
            `2026-07-${String(25 - (index % 20)).padStart(2, '0')}T12:00:00.000Z`,
          );
        }
      })();

      const snapshot = JSON.stringify({
        type: 'article',
        source: 'unit-test',
        authorUsername: 'thoughtful_author',
        title: 'An article revisited carefully',
      });
      db.prepare(`
        INSERT INTO feed_engagement_sessions (
          session_id, feed_item_id, opened_at, last_seen_at, closed_at,
          active_dwell_ms, max_scroll_depth_pct, user_scrolled, is_return, surface, item_snapshot
        ) VALUES
          ('detail:attention:first', 'attention-item', datetime('now', '-1 hour'), datetime('now', '-59 minutes'), datetime('now', '-59 minutes'), 45000, 68, 0, 0, 'detail_overlay', ?),
          ('detail:attention:return', 'attention-item', datetime('now', '-10 minutes'), datetime('now', '-8 minutes'), datetime('now', '-8 minutes'), 75000, 91, 0, 1, 'detail_overlay', ?),
          ('detail:accidental:tap', 'accidental-item', datetime('now', '-7 minutes'), datetime('now', '-7 minutes'), datetime('now', '-7 minutes'), 1200, 100, 0, 0, 'detail_overlay', ?),
          ('detail:deliberate:scroll', 'deliberate-item', datetime('now', '-6 minutes'), datetime('now', '-6 minutes'), datetime('now', '-6 minutes'), 6000, 35, 1, 0, 'detail_overlay', ?),
          ('detail:split:dwell', 'split-evidence-item', datetime('now', '-5 minutes'), datetime('now', '-5 minutes'), datetime('now', '-5 minutes'), 5000, 10, 0, 0, 'detail_overlay', ?),
          ('detail:split:scroll', 'split-evidence-item', datetime('now', '-5 minutes'), datetime('now', '-5 minutes'), datetime('now', '-5 minutes'), 0, 80, 1, 0, 'detail_overlay', ?),
          ('detail:rapid:first', 'rapid-return-item', datetime('now', '-5 minutes'), datetime('now', '-5 minutes'), datetime('now', '-5 minutes'), 2000, 100, 0, 0, 'detail_overlay', ?),
          ('detail:rapid:return', 'rapid-return-item', datetime('now', '-4 minutes'), datetime('now', '-4 minutes'), datetime('now', '-4 minutes'), 2000, 100, 0, 1, 'detail_overlay', ?)
      `).run(
        snapshot,
        snapshot,
        JSON.stringify({ title: 'Accidental full-depth tap' }),
        JSON.stringify({ title: 'Deliberately scrolled item' }),
        JSON.stringify({ title: 'Split evidence must not compose' }),
        JSON.stringify({ title: 'Split evidence must not compose' }),
        JSON.stringify({ title: 'Rapid return is still accidental' }),
        JSON.stringify({ title: 'Rapid return is still accidental' }),
      );

      const insertThreadFeedback = db.prepare(`
        INSERT INTO thread_feedback (
          id, thread_id, cycle_id, vote, thread_title, reason, category,
          probe_reason, probe_uncertainty, source_item_ids, created_at
        ) VALUES (?, ?, 'near-limit-cycle', ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      db.transaction(() => {
        for (let index = 0; index < 12; index += 1) {
          insertThreadFeedback.run(
            `near-limit-feedback-${index}`,
            `near-limit-thread-${index}`,
            index % 2 === 0 ? 'more' : 'less',
            `Thread feedback class survives byte compaction ${index} ${'topic '.repeat(30)}`,
            `User reason ${index} ${'specific '.repeat(30)}`,
            `category-${index}`,
            `Probe reason ${index} ${'detail '.repeat(30)}`,
            `Uncertainty ${index} ${'unknown '.repeat(30)}`,
            JSON.stringify(Array.from(
              { length: 4 },
              (_, itemIndex) => `source-${index}-${itemIndex}-${'identifier'.repeat(20)}`,
            )),
            `2026-07-25T12:${String(index).padStart(2, '0')}:00.000Z`,
          );
        }
      })();
    } finally {
      db.close();
    }

    const runtimeModuleUrl = `${pathToFileURL(path.join(originalCwd, 'src/lib/preferences-context-runtime.js')).href}?t=${Date.now()}`;
    const imported = await import(runtimeModuleUrl);
    const runtime = ((imported.default as PreferenceContextRuntimeModule | undefined) ?? imported) as PreferenceContextRuntimeModule;
    const writtenPath = await runtime.regeneratePreferenceContext();
    const firstMarkdown = await fs.promises.readFile(writtenPath, 'utf8');
    await runtime.regeneratePreferenceContext();
    const secondMarkdown = await fs.promises.readFile(writtenPath, 'utf8');

    assert.strictEqual(firstMarkdown, secondMarkdown);
    assert.ok(Buffer.byteLength(firstMarkdown, 'utf8') <= 16 * 1024);
    assert.ok(Buffer.byteLength(firstMarkdown, 'utf8') > 10 * 1024);
    assert.match(firstMarkdown, /Private raw preference evidence/);
    assert.match(firstMarkdown, /Behavioral Attention Facts \(newest item-open first; not approval\)/);
    assert.match(firstMarkdown, /2 opens, 1 returns, 2m active dwell, 91% max depth/);
    assert.match(firstMarkdown, /Deliberately scrolled item/);
    assert.match(firstMarkdown, /Accidental full-depth tap/);
    assert.match(firstMarkdown, /Rapid return is still accidental/);
    assert.match(firstMarkdown, /Split evidence must not compose/);
    assert.match(firstMarkdown, /Thread Feedback Evidence \(newest first\)/);
    assert.match(firstMarkdown, /near-limit-thread-11/);
    assert.match(firstMarkdown, /descriptive inputs.*does not infer favorites, relevance, or what to select or avoid/i);
    assert.match(firstMarkdown, /Raw preference and attention evidence remains in the private SQLite database/);
    assert.strictEqual((await fs.promises.stat(writtenPath)).mode & 0o777, 0o600);

    const verifyDb = new Database(process.env.MEDIA_AGENT_DB_PATH!, { readonly: true });
    try {
      assert.deepStrictEqual(
        verifyDb.prepare(`SELECT COUNT(*) AS count FROM preferences`).get(),
        { count: 220 },
      );
      assert.deepStrictEqual(
        verifyDb.prepare(`SELECT COUNT(*) AS count FROM feed_engagement_sessions`).get(),
        { count: 8 },
      );
      assert.deepStrictEqual(
        verifyDb.prepare(`SELECT COUNT(*) AS count FROM thread_feedback`).get(),
        { count: 12 },
      );
    } finally {
      verifyDb.close();
    }
  });
});
