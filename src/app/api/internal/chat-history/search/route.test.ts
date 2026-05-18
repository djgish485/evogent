import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { getDb } from '@/lib/db/client';

type GlobalWithDb = typeof globalThis & {
  evogentDb?: {
    close: () => void;
  };
};

type RouteModule = {
  GET: (request: Request) => Promise<Response>;
};

const globalWithDb = globalThis as GlobalWithDb;

describe('/api/internal/chat-history/search', { concurrency: false }, () => {
  let originalDataDir: string | undefined;
  let originalDbPath: string | undefined;
  let tempDir = '';

  beforeEach(async () => {
    originalDataDir = process.env.DATA_DIR;
    originalDbPath = process.env.MEDIA_AGENT_DB_PATH;
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evogent-chat-history-route-test-'));

    if (globalWithDb.evogentDb) {
      globalWithDb.evogentDb.close();
      delete globalWithDb.evogentDb;
    }

    process.env.DATA_DIR = tempDir;
    process.env.MEDIA_AGENT_DB_PATH = path.join(tempDir, 'media-agent.db');
  });

  afterEach(async () => {
    if (globalWithDb.evogentDb) {
      globalWithDb.evogentDb.close();
      delete globalWithDb.evogentDb;
    }

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

  async function importRoute(): Promise<RouteModule> {
    return import(`./route?t=${Date.now()}-${Math.random().toString(36).slice(2)}`) as Promise<RouteModule>;
  }

  test('returns recent matching chat messages with session metadata and snippets', async () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO chat_sessions (id, provider, provider_session_id, claude_session_id, title, created_at, updated_at)
      VALUES
        ('session-a', 'codex', 'session-a', 'session-a', 'Launch planning', ?, ?),
        ('session-b', 'codex', 'session-b', 'session-b', 'Other work', ?, ?)
    `).run(
      '2026-05-01T00:00:00.000Z',
      '2026-05-04T00:00:00.000Z',
      '2026-05-01T00:00:00.000Z',
      '2026-05-04T00:00:00.000Z',
    );

    db.prepare(`
      INSERT INTO chat_messages (id, type, role, session_id, text, timestamp, created_at)
      VALUES
        ('msg-old', 'chat', 'user', 'session-a', 'I will send the renewal notes later.', '2026-04-20T10:00:00.000Z', '2026-04-20T10:00:00.000Z'),
        ('msg-match', 'chat', 'user', 'session-a', 'Before the standup, I will send the renewal notes after checking the receipt trail.', '2026-05-04T10:00:00.000Z', '2026-05-04T10:00:00.000Z'),
        ('msg-other-session', 'chat', 'user', 'session-b', 'I will send the renewal notes from a different thread.', '2026-05-04T11:00:00.000Z', '2026-05-04T11:00:00.000Z'),
        ('msg-agent-event', 'agent_event', 'agent', 'session-a', 'I will send should not match because this is an event.', '2026-05-04T12:00:00.000Z', '2026-05-04T12:00:00.000Z')
    `).run();

    const { GET } = await importRoute();
    const response = await GET(new Request('http://127.0.0.1/api/internal/chat-history/search?q=will%20send&sessionId=session-a&since=2026-05-01T00%3A00%3A00.000Z&limit=10'));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');

    const body = await response.json() as {
      ok: boolean;
      count: number;
      results: Array<{
        messageId: string;
        sessionId: string;
        sessionTitle: string;
        role: string;
        createdAt: string;
        text: string;
        snippet: string;
      }>;
    };

    assert.equal(body.ok, true);
    assert.equal(body.count, 1);
    assert.equal(body.results[0]?.messageId, 'msg-match');
    assert.equal(body.results[0]?.sessionId, 'session-a');
    assert.equal(body.results[0]?.sessionTitle, 'Launch planning');
    assert.equal(body.results[0]?.role, 'user');
    assert.equal(body.results[0]?.createdAt, '2026-05-04T10:00:00.000Z');
    assert.equal(body.results[0]?.text, 'Before the standup, I will send the renewal notes after checking the receipt trail.');
    assert.match(body.results[0]?.snippet ?? '', /will send/);
  });

  test('rejects a missing query', async () => {
    const { GET } = await importRoute();
    const response = await GET(new Request('http://127.0.0.1/api/internal/chat-history/search'));
    assert.equal(response.status, 400);

    const body = await response.json() as { ok: boolean; error: string };
    assert.equal(body.ok, false);
    assert.match(body.error, /q/);
  });
});
