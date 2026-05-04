import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { getDb } from '@/lib/db/client';
import { insertChatMessage } from '@/lib/db/chat';
import { createChatSession } from '@/lib/db/chat-sessions';
import type { FeedListResponse } from '@/types/feed';
import { GET } from './route';

type GlobalWithDb = typeof globalThis & {
  evogentDb?: {
    close: () => void;
  };
};

const globalWithDb = globalThis as GlobalWithDb;

describe('/api/feed suggestion counts', () => {
  let originalDbPath: string | undefined;
  let tempDir = '';
  beforeEach(async () => {
    originalDbPath = process.env.MEDIA_AGENT_DB_PATH;
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evogent-feed-route-test-'));

    if (globalWithDb.evogentDb) {
      globalWithDb.evogentDb.close();
      delete globalWithDb.evogentDb;
    }

    process.env.MEDIA_AGENT_DB_PATH = path.join(tempDir, 'media-agent.db');
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

    if (tempDir) {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });
  test('pendingCounts.suggestion matches the unpaginated Suggestions pending lane', async () => {
    const db = getDb();

    db.prepare(`
      INSERT INTO feed (id, type, source, text, metadata, origin_session_id, published_at, created_at)
      VALUES
        ('pending-session-a', 'suggestion', 'claude', 'session pending A', '{"suggestionStatus":"pending"}', 'session-1', ?, ?),
        ('pending-session-b', 'suggestion', 'claude', 'session pending B', '{"suggestionStatus":"pending"}', 'session-2', ?, ?),
        ('pending-no-session', 'suggestion', 'claude', 'pending without session', '{"suggestionStatus":"pending"}', NULL, ?, ?),
        ('accepted-session', 'suggestion', 'claude', 'accepted session suggestion', '{"suggestionStatus":"pending"}', 'session-3', ?, ?),
        ('dismissed-session', 'suggestion', 'claude', 'dismissed session suggestion', '{"suggestionStatus":"pending"}', 'session-4', ?, ?)
    `).run(
      '2026-03-08T12:30:00.000Z',
      '2026-03-08T12:30:00.000Z',
      '2026-03-08T12:29:00.000Z',
      '2026-03-08T12:29:00.000Z',
      '2026-03-08T12:28:00.000Z',
      '2026-03-08T12:28:00.000Z',
      '2026-03-08T12:27:00.000Z',
      '2026-03-08T12:27:00.000Z',
      '2026-03-08T12:26:00.000Z',
      '2026-03-08T12:26:00.000Z',
    );

    db.prepare(`
      INSERT INTO interactions (feed_item_id, action)
      VALUES
        ('accepted-session', 'suggestion_accepted'),
        ('dismissed-session', 'suggestion_dismissed')
    `).run();

    const response = await GET(new Request('http://127.0.0.1/api/feed?type=suggestion&limit=2'));
    assert.strictEqual(response.status, 200);

    const data = await response.json() as FeedListResponse;
    const suggestionGroup = data.suggestionGroup;
    assert.ok(suggestionGroup);

    const pendingGroupIds = suggestionGroup.items
      .filter((item) => item.suggestionStatus === 'pending')
      .map((item) => item.id)
      .sort();

    assert.deepStrictEqual(pendingGroupIds, ['pending-no-session', 'pending-session-a', 'pending-session-b']);
    assert.strictEqual(data.pendingCounts?.suggestion, pendingGroupIds.length);
    assert.ok(pendingGroupIds.length > data.items.length, 'pending count should not be limited to the current page');
  });

  test('returns stored prominence metadata on feed items', async () => {
    const db = getDb();

    db.prepare(`
      INSERT INTO feed (id, type, source, source_id, title, text, metadata, published_at, created_at)
      VALUES (?, 'article', 'nytimes', ?, 'Lead story', 'Lead story summary', ?, ?, ?)
    `).run(
      'prominent-article',
      'https://www.nytimes.com/example',
      JSON.stringify({
        prominence: {
          level: 'lead',
          source: 'homepage',
          evidence: 'Large headline in the top homepage slot.',
        },
      }),
      '2026-04-25T12:00:00.000Z',
      '2026-04-25T12:00:00.000Z',
    );

    const response = await GET(new Request('http://127.0.0.1/api/feed?limit=5'));
    assert.strictEqual(response.status, 200);

    const data = await response.json() as FeedListResponse;
    const item = data.items.find((entry) => entry.id === 'prominent-article');
    assert.ok(item);
    assert.deepEqual(item.metadata?.prominence, {
      level: 'lead',
      source: 'homepage',
      evidence: 'Large headline in the top homepage slot.',
    });
  });

  test('returns stored thread prominence metadata on feed items', async () => {
    const db = getDb();

    db.prepare(`
      INSERT INTO feed (id, type, source, source_id, title, text, metadata, published_at, created_at)
      VALUES (?, 'article', 'nytimes', ?, 'Thread story', 'Thread story summary', ?, ?, ?)
    `).run(
      'thread-prominent-article',
      'https://www.nytimes.com/example-thread',
      JSON.stringify({
        cycleId: 'cycle-1',
        thread: {
          threadId: 'thread-1',
          threadTitle: 'Major thread title',
          prominence: {
            level: 'lead',
            source: 'homepage',
            evidence: 'Large headline in the top homepage slot.',
            homepageUrl: 'https://www.nytimes.com/',
          },
        },
      }),
      '2026-04-25T12:00:00.000Z',
      '2026-04-25T12:00:00.000Z',
    );

    const response = await GET(new Request('http://127.0.0.1/api/feed?limit=5'));
    assert.strictEqual(response.status, 200);

    const data = await response.json() as FeedListResponse;
    const item = data.items.find((entry) => entry.id === 'thread-prominent-article');
    assert.ok(item);
    assert.deepEqual(item.metadata?.thread?.prominence, {
      level: 'lead',
      source: 'homepage',
      evidence: 'Large headline in the top homepage slot.',
      homepageUrl: 'https://www.nytimes.com/',
    });
  });

  test('returns chat session matches when search only matches chat message text', async () => {
    const session = createChatSession({
      id: '11111111-1111-4111-8111-111111111111',
      providerSessionId: '11111111-1111-4111-8111-111111111111',
      title: 'Research chat',
    });
    insertChatMessage({
      id: 'msg-chat-only-match',
      role: 'user',
      sessionId: session.id,
      text: 'The durable needle appears only inside chat history.',
      timestamp: '2026-04-25T12:00:00.000Z',
    });

    const response = await GET(new Request('http://127.0.0.1/api/feed?q=needle&limit=5'));
    assert.strictEqual(response.status, 200);

    const data = await response.json() as FeedListResponse;
    assert.deepStrictEqual(data.items.map((item) => item.id), []);
    assert.deepStrictEqual(data.chatSessionMatches?.map((match) => match.sessionId), [session.id]);
    assert.strictEqual(data.chatSessionMatches?.[0]?.latestMessageId, 'msg-chat-only-match');
    assert.strictEqual(data.chatSessionMatches?.[0]?.messages[0]?.text, 'The durable needle appears only inside chat history.');
  });

  test('returns feed and chat matches together for the same search', async () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO feed (id, type, source, title, text, published_at, created_at)
      VALUES (?, 'article', 'manual', ?, ?, ?, ?)
    `).run(
      'feed-search-match',
      'Needle report',
      'Feed body also includes the needle.',
      '2026-04-25T12:00:00.000Z',
      '2026-04-25T12:00:00.000Z',
    );
    const session = createChatSession({
      id: '22222222-2222-4222-8222-222222222222',
      providerSessionId: '22222222-2222-4222-8222-222222222222',
      title: 'Needle chat',
    });
    insertChatMessage({
      id: 'msg-both-match',
      role: 'agent',
      sessionId: session.id,
      text: 'Chat body also mentions NEEDLE in uppercase.',
      timestamp: '2026-04-25T12:01:00.000Z',
    });

    const response = await GET(new Request('http://127.0.0.1/api/feed?q=needle&limit=5'));
    assert.strictEqual(response.status, 200);

    const data = await response.json() as FeedListResponse;
    assert.deepStrictEqual(data.items.map((item) => item.id), ['feed-search-match']);
    assert.deepStrictEqual(data.chatSessionMatches?.map((match) => match.sessionId), [session.id]);
  });

  test('does not return chat matches when no chat message matches search', async () => {
    const session = createChatSession({
      id: '33333333-3333-4333-8333-333333333333',
      providerSessionId: '33333333-3333-4333-8333-333333333333',
      title: 'Unmatched chat',
    });
    insertChatMessage({
      id: 'msg-no-match',
      role: 'user',
      sessionId: session.id,
      text: 'This chat talks about something else.',
      timestamp: '2026-04-25T12:00:00.000Z',
    });

    const response = await GET(new Request('http://127.0.0.1/api/feed?q=needle&limit=5'));
    assert.strictEqual(response.status, 200);

    const data = await response.json() as FeedListResponse;
    assert.deepStrictEqual(data.items, []);
    assert.deepStrictEqual(data.chatSessionMatches, []);
  });

  test('chat search follows current case-insensitive multi-token feed search semantics', async () => {
    const session = createChatSession({
      id: '44444444-4444-4444-8444-444444444444',
      providerSessionId: '44444444-4444-4444-8444-444444444444',
      title: 'Token chat',
    });
    insertChatMessage({
      id: 'msg-token-match',
      role: 'user',
      sessionId: session.id,
      text: 'Only alpha is present in this chat message.',
      timestamp: '2026-04-25T12:00:00.000Z',
    });

    const response = await GET(new Request('http://127.0.0.1/api/feed?q=ALPHA%20missing&limit=5'));
    assert.strictEqual(response.status, 200);

    const data = await response.json() as FeedListResponse;
    assert.deepStrictEqual(data.chatSessionMatches?.map((match) => match.sessionId), [session.id]);
  });
});
