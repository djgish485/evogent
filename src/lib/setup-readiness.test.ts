import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { getDb } from './db/client';
import { recordBrowseCacheRefresh } from './db/browse-cache';
import { setFeedItemSuggestionStatus } from './db/feed';
import { installSkill } from './skills';
import {
  SETUP_WELCOME_NOTIFICATION_SOURCE_ID,
  SETUP_WELCOME_NOTIFICATION_TEXT,
  SETUP_WELCOME_NOTIFICATION_TITLE,
  getFirstRunReadiness,
  getSourceReadiness,
  type ProviderAvailability,
} from './setup-readiness';
import {
  DEFAULT_CURATOR_CHAT_SESSION_ID,
  DEFAULT_MAIN_CHAT_SESSION_ID,
  createChatSession,
  type BrainProviderName,
} from './db/chat-sessions';

type GlobalWithDb = typeof globalThis & {
  evogentDb?: {
    close: () => void;
  };
};

const globalWithDb = globalThis as GlobalWithDb;

function providerAvailability(available: Partial<Record<BrainProviderName, boolean>>) {
  return async (provider: BrainProviderName): Promise<ProviderAvailability> => ({
    provider,
    providerDisplayName: provider === 'codex' ? 'Codex CLI' : 'Claude Code',
    providerBinary: provider,
    available: available[provider] === true,
    version: available[provider] ? `${provider}-test` : null,
    error: available[provider] ? null : `${provider} missing`,
  });
}

function writeConfig(dataDir: string, provider = 'Claude Code'): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.md'), [
    '# Evogent Config',
    '',
    '## Agent Name',
    'Evogent',
    '',
    '## Brain Provider',
    provider,
    '',
    '## Usage Level',
    'Medium',
    '',
  ].join('\n'), 'utf8');
}

describe('first-run setup readiness', () => {
  let originalDbPath: string | undefined;
  let originalDataDir: string | undefined;
  let originalEvogentRoot: string | undefined;
  let originalSkillsDir: string | undefined;
  let originalPath: string | undefined;
  let tempDir = '';

  beforeEach(async () => {
    originalDbPath = process.env.MEDIA_AGENT_DB_PATH;
    originalDataDir = process.env.DATA_DIR;
    originalEvogentRoot = process.env.MEDIA_AGENT_ROOT;
    originalSkillsDir = process.env.MEDIA_AGENT_SKILLS_DIR;
    originalPath = process.env.PATH;
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evogent-readiness-test-'));

    if (globalWithDb.evogentDb) {
      globalWithDb.evogentDb.close();
      delete globalWithDb.evogentDb;
    }

    process.env.DATA_DIR = path.join(tempDir, 'data');
    process.env.MEDIA_AGENT_DB_PATH = path.join(tempDir, 'data', 'media-agent.db');
    process.env.MEDIA_AGENT_SKILLS_DIR = path.join(tempDir, 'skills');
    const binDir = path.join(tempDir, 'bin');
    await fs.promises.mkdir(binDir, { recursive: true });
    await fs.promises.writeFile(path.join(binDir, 'claude'), '#!/usr/bin/env sh\necho claude-test\n', { mode: 0o755 });
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`;
    writeConfig(process.env.DATA_DIR, 'Codex CLI');
  });

  afterEach(async () => {
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

    if (originalEvogentRoot === undefined) {
      delete process.env.MEDIA_AGENT_ROOT;
    } else {
      process.env.MEDIA_AGENT_ROOT = originalEvogentRoot;
    }

    if (originalSkillsDir === undefined) {
      delete process.env.MEDIA_AGENT_SKILLS_DIR;
    } else {
      process.env.MEDIA_AGENT_SKILLS_DIR = originalSkillsDir;
    }

    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }

    if (tempDir) {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('readiness reads do not create default sessions when a provider is selected', async () => {
    await installSkill({ registry: 'tweet-cache' });
    createChatSession({
      id: '00000000-0000-4000-8000-000000000099',
      title: 'Existing User Session',
    });

    const first = await getFirstRunReadiness({
      checkProviderAvailability: providerAvailability({ claude: true, codex: true }),
    });
    const second = await getFirstRunReadiness({
      checkProviderAvailability: providerAvailability({ claude: true, codex: true }),
    });

    assert.strictEqual(first.provider.selected, 'codex');
    assert.strictEqual(second.provider.selected, 'codex');
    assert.strictEqual(first.sessions.ready, false);
    assert.strictEqual(second.sessions.ready, false);

    const rows = getDb().prepare(`
      SELECT id, title, updated_at AS updatedAt
      FROM chat_sessions
      ORDER BY id ASC
    `).all() as Array<{ id: string; title: string; updatedAt: string }>;

    assert.deepStrictEqual(rows, [{
      id: '00000000-0000-4000-8000-000000000099',
      title: 'Existing User Session',
      updatedAt: rows[0]!.updatedAt,
    }]);
  });

  test('explicit default-session bootstrap is idempotent and does not churn updated_at', async () => {
    await installSkill({ registry: 'tweet-cache' });
    process.env.MEDIA_AGENT_ROOT = '/root/evogent';

    const first = await getFirstRunReadiness({
      checkProviderAvailability: providerAvailability({ claude: true, codex: true }),
      bootstrapDefaultSessions: true,
    });
    const rowsAfterFirst = getDb().prepare(`
      SELECT id, title, provider, session_type, working_directory, updated_at AS updatedAt
      FROM chat_sessions
      ORDER BY title ASC
    `).all() as Array<{
      id: string;
      title: string;
      provider: string;
      session_type: string | null;
      working_directory: string;
      updatedAt: string;
    }>;
    const second = await getFirstRunReadiness({
      checkProviderAvailability: providerAvailability({ claude: true, codex: true }),
      bootstrapDefaultSessions: true,
    });
    const rowsAfterSecond = getDb().prepare(`
      SELECT id, title, provider, session_type, working_directory, updated_at AS updatedAt
      FROM chat_sessions
      ORDER BY title ASC
    `).all() as typeof rowsAfterFirst;

    assert.strictEqual(first.sessions.ready, true);
    assert.strictEqual(second.sessions.ready, true);
    assert.match(first.ready.join('\n'), /Default General Agent and Curator Agent chat sessions exist\./);
    assert.deepStrictEqual(rowsAfterSecond, rowsAfterFirst);
    assert.deepStrictEqual(rowsAfterSecond.map((row) => row.id).sort(), [
      DEFAULT_MAIN_CHAT_SESSION_ID,
      DEFAULT_CURATOR_CHAT_SESSION_ID,
    ].sort());
    assert.deepStrictEqual(rowsAfterSecond.map((row) => row.title).sort(), ['Curator Agent', 'General Agent']);
    assert.ok(rowsAfterSecond.every((row) => row.provider === 'codex'));
    assert.ok(rowsAfterSecond.every((row) => row.working_directory === process.cwd()));
    assert.strictEqual(rowsAfterSecond.find((row) => row.title === 'Curator Agent')?.session_type, 'curator');
    assert.strictEqual(rowsAfterSecond.find((row) => row.title === 'General Agent')?.session_type, null);
  });

  test('does not create default sessions when no brain provider is runnable', async () => {
    await installSkill({ registry: 'tweet-cache' });

    const readiness = await getFirstRunReadiness({
      checkProviderAvailability: providerAvailability({ claude: false, codex: false }),
    });

    assert.strictEqual(readiness.provider.selected, null);
    assert.strictEqual(readiness.sessions.ready, false);
    assert.match(readiness.required.join('\n'), /Install Claude Code or Codex CLI/);
    const count = (getDb().prepare('SELECT COUNT(*) AS count FROM chat_sessions').get() as { count: number }).count;
    assert.strictEqual(count, 0);
  });

  test('does not silently switch an explicit provider when only another provider is runnable', async () => {
    await installSkill({ registry: 'tweet-cache' });
    writeConfig(process.env.DATA_DIR!, 'Claude Code');

    const readiness = await getFirstRunReadiness({
      checkProviderAvailability: providerAvailability({ claude: false, codex: true }),
    });

    assert.strictEqual(readiness.provider.selected, null);
    assert.match(readiness.provider.message, /Install Claude Code or Codex CLI/);
    assert.match(fs.readFileSync(path.join(process.env.DATA_DIR!, 'config.md'), 'utf8'), /## Brain Provider\nClaude Code/);
  });

  test('emits the setup welcome notification once when readiness first flips ready', async () => {
    const notifiedIds: string[] = [];
    const options = {
      checkProviderAvailability: providerAvailability({ claude: true, codex: true }),
      notifyWelcomeNotification: (item: { id: string }) => {
        notifiedIds.push(item.id);
      },
    };

    const initial = await getFirstRunReadiness(options);
    assert.notStrictEqual(initial.required.length, 0);

    await installSkill({ registry: 'hackernews-cache' });
    const ready = await getFirstRunReadiness(options);
    const readyAgain = await getFirstRunReadiness(options);

    assert.strictEqual(ready.required.length, 0);
    assert.strictEqual(readyAgain.required.length, 0);
    assert.deepStrictEqual(notifiedIds, ['setup-welcome-notification']);

    const rows = getDb().prepare(`
      SELECT id, title, text, source_id AS sourceId, metadata
      FROM feed
      WHERE type = 'notification'
        AND source_id = ?
      ORDER BY created_at_ms ASC
    `).all(SETUP_WELCOME_NOTIFICATION_SOURCE_ID) as Array<{
      id: string;
      title: string;
      text: string;
      sourceId: string;
      metadata: string;
    }>;

    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0]!.title, SETUP_WELCOME_NOTIFICATION_TITLE);
    assert.strictEqual(rows[0]!.text, SETUP_WELCOME_NOTIFICATION_TEXT);
    assert.strictEqual(rows[0]!.sourceId, SETUP_WELCOME_NOTIFICATION_SOURCE_ID);
    assert.deepStrictEqual(JSON.parse(rows[0]!.metadata), {
      notificationId: SETUP_WELCOME_NOTIFICATION_SOURCE_ID,
      severity: 'info',
      dismissable: true,
    });
    assert.match(rows[0]!.text, /Curate button in the Curator Agent/i);
    assert.match(rows[0]!.text, /curations will happen automatically/i);
    assert.match(rows[0]!.text, /feedback or questions about the curation quality/i);
    assert.match(rows[0]!.text, /General Agent can be used for anything/i);

    setFeedItemSuggestionStatus(rows[0]!.id, 'dismissed');
    await getFirstRunReadiness(options);
    const countAfterDismiss = (getDb().prepare(`
      SELECT COUNT(*) AS count
      FROM feed
      WHERE type = 'notification'
        AND source_id = ?
    `).get(SETUP_WELCOME_NOTIFICATION_SOURCE_ID) as { count: number }).count;
    assert.strictEqual(countAfterDismiss, 1);
  });

  test('does not retroactively emit welcome notification for already-ready installs', async () => {
    await installSkill({ registry: 'hackernews-cache' });
    const notifiedIds: string[] = [];

    const ready = await getFirstRunReadiness({
      checkProviderAvailability: providerAvailability({ claude: true, codex: true }),
      notifyWelcomeNotification: (item) => {
        notifiedIds.push(item.id);
      },
    });

    assert.strictEqual(ready.required.length, 0);
    assert.deepStrictEqual(notifiedIds, []);
    const count = (getDb().prepare(`
      SELECT COUNT(*) AS count
      FROM feed
      WHERE type = 'notification'
        AND source_id = ?
    `).get(SETUP_WELCOME_NOTIFICATION_SOURCE_ID) as { count: number }).count;
    assert.strictEqual(count, 0);
  });

  test('source readiness requires packaged setup-smoke evidence for browser-backed skills', async () => {
    const empty = await getSourceReadiness();
    assert.strictEqual(empty.ready, false);
    assert.match(empty.message, /which content source/i);

    await installSkill({ registry: 'tweet-cache' });
    const installedOnly = await getSourceReadiness();
    assert.strictEqual(installedOnly.ready, false);
    assert.match(installedOnly.message, /packaged setup-smoke evidence/i);

    const now = Date.now();
    recordBrowseCacheRefresh({
      runId: 'manual-local-scraper',
      source: 'twitter',
      triggeredBy: 'manual',
      startedAtMs: now - 1000,
      completedAtMs: now,
      status: 'completed',
      itemsAdded: 5,
    });
    const manualOnly = await getSourceReadiness();
    assert.strictEqual(manualOnly.ready, false);

    recordBrowseCacheRefresh({
      runId: 'setup-source-twitter-setup-source-twitter-test',
      source: 'twitter',
      triggeredBy: 'setup-source-smoke',
      startedAtMs: now - 1000,
      completedAtMs: now,
      status: 'completed',
      itemsAdded: 5,
    });
    const ready = await getSourceReadiness();
    assert.strictEqual(ready.ready, true);
    assert.deepStrictEqual(ready.items.map((item) => item.skill), ['tweet-cache']);
    assert.match(ready.message, /run=setup-source-twitter-setup-source-twitter-test task=setup-source-twitter-test rows=5/);
  });

  test('source readiness reports installed browser-backed sources with setup-smoke evidence', async () => {
    await installSkill({ registry: 'tweet-cache' });
    await installSkill({ registry: 'youtube-cache' });
    await installSkill({ registry: 'substack-cache' });

    const now = Date.now();
    recordBrowseCacheRefresh({
      runId: 'setup-source-twitter-selected-source',
      source: 'twitter',
      triggeredBy: 'setup-source-smoke',
      startedAtMs: now - 1000,
      completedAtMs: now,
      status: 'completed',
      itemsAdded: 5,
    });

    const readiness = await getSourceReadiness();

    assert.strictEqual(readiness.ready, true);
    assert.deepStrictEqual(readiness.items.map((item) => item.source), ['twitter']);
    assert.doesNotMatch(readiness.message, /youtube|substack/i);
  });

  test('source readiness passes Hacker News through without setup-smoke evidence', async () => {
    await installSkill({ registry: 'hackernews-cache' });

    const installedOnly = await getSourceReadiness();
    assert.strictEqual(installedOnly.ready, true);
    assert.deepStrictEqual(installedOnly.items, [{
      source: 'hackernews',
      label: 'Hacker News',
      skill: 'hackernews-cache',
      evidence: null,
    }]);
    assert.match(installedOnly.message, /Content source ready: Hacker News\./);
  });
});
