import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, test } from 'node:test';
import { getDb } from '@/lib/db/client';
import { createChatSession } from '@/lib/db/chat-sessions';
import { insertChatMessage } from '@/lib/db/chat';
import { getDataPath } from '@/lib/data-dir';
import { updateBrainConfigContent } from '../../../lib/brain-config.js';
import {
  cleanupValidationFixtures,
  createValidationOriginSessionId,
  requireValidationIsolationContext,
} from '../../../test/integration-fixture-helpers';

const INTEGRATION_SKIP_REASON = process.env.TEST_SERVER_URL
  && (process.env.TEST_SERVER_DATA_DIR || process.env.DATA_DIR)
  ? undefined
  : 'requires TEST_SERVER_URL plus TEST_SERVER_DATA_DIR or DATA_DIR for an isolated validation server';
const INTEGRATION_CONTEXT = INTEGRATION_SKIP_REASON
  ? null
  : requireValidationIsolationContext('API integration tests');
const BASE_URL = INTEGRATION_CONTEXT?.baseUrl ?? 'http://127.0.0.1';

function requireConfigMutationIsolation() {
  return requireValidationIsolationContext('Config API integration tests');
}

interface JsonResponse<T = unknown> {
  status: number;
  data: T;
}

interface FeedListResponse {
  items: Array<Record<string, unknown>>;
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  pendingCounts?: Record<string, number>;
  suggestionGroup?: {
    title?: string;
    items?: Array<Record<string, unknown>>;
    latestTimestamp?: string | null;
  } | null;
}

function assertParsableTimestamps(items: Array<Record<string, unknown>>, field: 'createdAt' | 'publishedAt') {
  for (const [index, item] of items.entries()) {
    const value = item[field];
    assert.strictEqual(typeof value, 'string');
    assert.ok(Number.isFinite(Date.parse(value)), `Expected valid ${field} at index ${index}`);
  }
}

async function requestJson<T = unknown>(path: string, init?: RequestInit): Promise<JsonResponse<T>> {
  const response = await fetch(`${BASE_URL}${path}`, {
    cache: 'no-store',
    ...init,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) as T : {} as T;
  return {
    status: response.status,
    data,
  };
}

async function waitForOrchestratorTask(
  requestId: string,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<Record<string, unknown>> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervalMs = options.intervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const response = await requestJson('/api/orchestrator/status');
    assert.strictEqual(response.status, 200);
    assertObject(response.data, 'Expected orchestrator status payload');

    const candidates = [
      response.data.currentTask,
      ...(Array.isArray(response.data.queued) ? response.data.queued : []),
      ...(Array.isArray(response.data.history) ? response.data.history : []),
    ];

    const match = candidates.find((task) => {
      return task && typeof task === 'object' && task.id === requestId;
    });

    if (match && typeof match === 'object') {
      return match as Record<string, unknown>;
    }

    await delay(intervalMs);
  }

  throw new Error(`Timed out waiting for orchestrator task ${requestId}`);
}

async function notifyCodeFixLifecycle(taskId: string, status: 'running' | 'merged' | 'failed'): Promise<void> {
  const response = await requestJson('/api/internal/code-fix-orchestrator/lifecycle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskId, status }),
  });
  assert.strictEqual(response.status, 200);
}

function getCodeFixTaskRow(taskId: string) {
  const db = getDb();
  return db.prepare(`
    SELECT
      suggestion_id as suggestionId,
      task_id as taskId,
      status,
      phase,
      phase_detail as phaseDetail,
      error,
      completed_at as completedAt
    FROM code_fix_tasks
    WHERE task_id = ?
  `).get(taskId) as Record<string, unknown> | undefined;
}

function getCodeFixTaskRowsForSuggestion(suggestionId: string) {
  const db = getDb();
  return db.prepare(`
    SELECT
      suggestion_id as suggestionId,
      task_id as taskId,
      status,
      phase,
      phase_detail as phaseDetail,
      error,
      completed_at as completedAt
    FROM code_fix_tasks
    WHERE suggestion_id = ?
    ORDER BY id ASC
  `).all(suggestionId) as Array<Record<string, unknown>>;
}

function insertCodeFixTaskRow(input: {
  suggestionId: string;
  taskId: string;
  status: string;
  phase?: string | null;
  phaseDetail?: string | null;
}) {
  const db = getDb();
  db.prepare(`
    INSERT INTO code_fix_tasks (
      suggestion_id,
      task_id,
      status,
      phase,
      phase_detail
    ) VALUES (?, ?, ?, ?, ?)
  `).run(
    input.suggestionId,
    input.taskId,
    input.status,
    input.phase ?? null,
    input.phaseDetail ?? null,
  );
}

function assertObject(value: unknown, message: string): asserts value is Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), message);
}

let cachedFeedItemId: string | null = null;
let cachedInteractionItemId: string | null = null;

async function getFeedItems(limit = 25): Promise<Array<Record<string, unknown>>> {
  const response = await requestJson<FeedListResponse>(`/api/feed?limit=${limit}`);
  assert.strictEqual(response.status, 200);
  assert.ok(Array.isArray(response.data.items));
  return response.data.items;
}

async function getFeedItemId(): Promise<string> {
  if (cachedFeedItemId) return cachedFeedItemId;
  const items = await getFeedItems(25);
  assert.ok(items.length > 0, 'Expected at least one feed item for ID-based API tests');
  const id = items[0]?.id;
  assert.strictEqual(typeof id, 'string');
  cachedFeedItemId = id;
  return id;
}

async function getInteractionFeedItemId(): Promise<string> {
  if (cachedInteractionItemId) return cachedInteractionItemId;

  const items = await getFeedItems(50);
  assert.ok(items.length > 0, 'Expected at least one feed item for interaction tests');

  const nonTwitter = items.find((item) => {
    const source = typeof item.source === 'string' ? item.source.toLowerCase() : '';
    return source !== 'twitter' && source !== 'x';
  });
  const chosen = nonTwitter ?? items[0];
  const id = chosen?.id;
  assert.strictEqual(typeof id, 'string');
  cachedInteractionItemId = id;
  return id;
}

function createTestFeedItem(input: {
  type: 'tweet' | 'article' | 'analysis' | 'suggestion' | 'notification';
  source?: string | null;
  sourceId?: string | null;
  parentId?: string | null;
  relationship?: string | null;
  metricsLikes?: number;
  title?: string | null;
  text?: string;
  originSessionId?: string | null;
  metadata?: Record<string, unknown> | null;
  publishedAt?: string;
}) {
  const db = getDb();
  const id = `api-like-test-${randomUUID()}`;
  db.prepare(`
    INSERT INTO feed (
      id, type, source, source_id, parent_id, relationship, title, text, origin_session_id, published_at, metrics_likes, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.type,
    input.source ?? null,
    input.sourceId ?? null,
    input.parentId ?? null,
    input.relationship ?? null,
    input.title ?? null,
    input.text ?? `test item ${id}`,
    input.originSessionId ?? null,
    input.publishedAt ?? '2026-03-08T12:00:00.000Z',
    input.metricsLikes ?? 0,
    input.metadata ? JSON.stringify(input.metadata) : null,
  );

  return id;
}

function removeTestFeedItem(id: string) {
  const db = getDb();
  db.prepare('DELETE FROM code_fix_tasks WHERE suggestion_id = ?').run(id);
  db.prepare('DELETE FROM preferences WHERE feed_item_id = ?').run(id);
  db.prepare('DELETE FROM interactions WHERE feed_item_id = ?').run(id);
  db.prepare('DELETE FROM feed WHERE id = ?').run(id);
}

async function getFileSize(filePath: string): Promise<number> {
  try {
    const stat = await fs.promises.stat(filePath);
    return stat.size;
  } catch {
    return 0;
  }
}

async function readJsonlEntriesSince(filePath: string, offset: number): Promise<Array<Record<string, unknown>>> {
  const size = await getFileSize(filePath);
  if (size <= offset) {
    return [];
  }

  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(size - offset);
    await handle.read(buffer, 0, size - offset, offset);
    return buffer
      .toString('utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } finally {
    await handle.close();
  }
}

async function preserveFile(filePath: string): Promise<() => Promise<void>> {
  try {
    const original = await fs.promises.readFile(filePath);
    return async () => {
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.writeFile(filePath, original);
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return async () => {
        await fs.promises.rm(filePath, { force: true });
      };
    }
    throw error;
  }
}

async function listMarkdownSnapshots(dirPath: string): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

describe('API Integration Tests', { concurrency: false, skip: INTEGRATION_SKIP_REASON }, () => {
  describe('Feed API', () => {
    test('GET /api/feed returns items/total/offset/limit/hasMore', async () => {
      const response = await requestJson<FeedListResponse>('/api/feed');
      assert.strictEqual(response.status, 200);
      assert.ok(Array.isArray(response.data.items));
      assert.strictEqual(typeof response.data.total, 'number');
      assert.strictEqual(typeof response.data.offset, 'number');
      assert.strictEqual(typeof response.data.limit, 'number');
      assert.strictEqual(typeof response.data.hasMore, 'boolean');
      assertObject(response.data.pendingCounts, 'Expected pendingCounts object');
    });

    test('GET /api/feed?type=tweet filters to tweets only', async () => {
      const response = await requestJson<FeedListResponse>('/api/feed?type=tweet&limit=25');
      assert.strictEqual(response.status, 200);
      assert.ok(response.data.items.every((item) => item.type === 'tweet'));
    });

    test('GET /api/feed?type=tweet,article filters to multiple types', async () => {
      const response = await requestJson<FeedListResponse>('/api/feed?type=tweet,article&limit=25');
      assert.strictEqual(response.status, 200);
      assert.ok(response.data.items.every((item) => item.type === 'tweet' || item.type === 'article'));
    });

    test('GET /api/feed?limit=5 respects limit', async () => {
      const response = await requestJson<FeedListResponse>('/api/feed?limit=5');
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.data.limit, 5);
      assert.ok(response.data.items.length <= 5);
    });

    test('GET /api/feed?offset=1000 returns empty items with hasMore=false', async () => {
      const response = await requestJson<FeedListResponse>('/api/feed?offset=1000');
      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(response.data.items, []);
      assert.strictEqual(response.data.hasMore, false);
    });

    test('GET /api/feed accepts sort=created and sort=published', async () => {
      const createdResponse = await requestJson<FeedListResponse>('/api/feed?sort=created&limit=25');
      assert.strictEqual(createdResponse.status, 200);
      assert.ok(createdResponse.data.items.length > 0);
      assertParsableTimestamps(createdResponse.data.items, 'createdAt');

      const publishedResponse = await requestJson<FeedListResponse>('/api/feed?sort=published&limit=25');
      assert.strictEqual(publishedResponse.status, 200);
      assert.ok(publishedResponse.data.items.length > 0);
      assertParsableTimestamps(publishedResponse.data.items, 'publishedAt');
    });

    test('GET /api/feed returns pending suggestion and notification counts', async () => {
      createTestFeedItem({
        type: 'suggestion',
        source: 'claude',
        title: 'Pending suggestion count test',
        text: 'Should count as pending suggestion.',
        publishedAt: '2026-03-09T12:10:00.000Z',
        metadata: {
          suggestionStatus: 'pending',
        },
      });
      const dismissedSuggestionId = createTestFeedItem({
        type: 'suggestion',
        source: 'claude',
        title: 'Dismissed suggestion count test',
        text: 'Should not count after dismissal.',
        publishedAt: '2026-03-09T12:10:30.000Z',
        metadata: {
          suggestionStatus: 'pending',
        },
      });
      createTestFeedItem({
        type: 'notification',
        source: 'system',
        sourceId: `notification-count-${randomUUID()}`,
        title: 'Notification count test',
        text: 'Should count as active notification.',
        publishedAt: '2026-03-09T12:11:00.000Z',
        metadata: {
          notificationId: `notification-count-${randomUUID()}`,
          severity: 'warning',
          dismissable: true,
        },
      });
      createTestFeedItem({
        type: 'suggestion',
        source: 'claude',
        title: 'Non-pending suggestion count test',
        text: 'Should not count as pending suggestion.',
        publishedAt: '2026-03-09T12:12:00.000Z',
        metadata: {
          suggestionStatus: 'running',
        },
      });

      await requestJson('/api/interactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          feedItemId: dismissedSuggestionId,
          action: 'dismiss_suggestion',
        }),
      });

      const response = await requestJson<FeedListResponse>('/api/feed?limit=5');
      assert.strictEqual(response.status, 200);
      assertObject(response.data.pendingCounts, 'Expected pendingCounts object');
      assert.strictEqual(typeof response.data.pendingCounts?.suggestion, 'number');
      assert.strictEqual(typeof response.data.pendingCounts?.notification, 'number');
      assert.ok((response.data.pendingCounts?.suggestion ?? 0) >= 1);
      assert.ok((response.data.pendingCounts?.notification ?? 0) >= 1);
    });

    test('GET /api/feed surfaces active notifications first and filters dismissed or expired ones', async () => {
      const db = getDb();
      const activeNotificationId = createTestFeedItem({
        type: 'notification',
        source: 'system',
        sourceId: `notification-active-${randomUUID()}`,
        title: 'Active notification',
        text: 'Active notification should be visible.',
        publishedAt: '2026-03-08T12:10:00.000Z',
        metadata: {
          notificationId: `notification-active-${randomUUID()}`,
          severity: 'warning',
          dismissable: true,
        },
      });
      const dismissedNotificationId = createTestFeedItem({
        type: 'notification',
        source: 'system',
        sourceId: `notification-dismissed-${randomUUID()}`,
        title: 'Dismissed notification',
        text: 'Dismissed notification should be hidden.',
        publishedAt: '2026-03-08T12:09:00.000Z',
        metadata: {
          notificationId: `notification-dismissed-${randomUUID()}`,
          severity: 'info',
          dismissable: true,
        },
      });
      const expiredNotificationId = createTestFeedItem({
        type: 'notification',
        source: 'system',
        sourceId: `notification-expired-${randomUUID()}`,
        title: 'Expired notification',
        text: 'Expired notification should be hidden.',
        publishedAt: '2026-03-08T12:08:00.000Z',
        metadata: {
          notificationId: `notification-expired-${randomUUID()}`,
          severity: 'error',
          dismissable: true,
          expiresAt: '2026-03-08T12:09:00.000Z',
        },
      });
      const suggestionId = createTestFeedItem({
        type: 'suggestion',
        source: 'claude',
        sourceId: `suggestion-${randomUUID()}`,
        title: 'Pending suggestion',
        text: 'Pending suggestion should sort below active notifications.',
        publishedAt: '2026-03-08T12:07:00.000Z',
        metadata: {
          suggestionType: 'code_fix',
          proposedValue: 'Raise the usage level threshold to keep suggestions pending below notifications.',
        },
      });

      db.prepare(`
        INSERT OR IGNORE INTO interactions (feed_item_id, action)
        VALUES (?, 'suggestion_dismissed')
      `).run(dismissedNotificationId);

      try {
        const response = await requestJson<FeedListResponse>('/api/feed?type=notification,suggestion&limit=25');
        assert.strictEqual(response.status, 200);

        const ids = response.data.items.map((item) => item.id);
        assert.ok(ids.includes(activeNotificationId));
        assert.ok(ids.includes(suggestionId));
        assert.ok(!ids.includes(dismissedNotificationId));
        assert.ok(!ids.includes(expiredNotificationId));
        assert.ok(ids.indexOf(activeNotificationId) < ids.indexOf(suggestionId));
      } finally {
        removeTestFeedItem(activeNotificationId);
        removeTestFeedItem(dismissedNotificationId);
        removeTestFeedItem(expiredNotificationId);
        removeTestFeedItem(suggestionId);
      }
    });

    test('GET /api/feed returns a deterministic suggestionGroup focused on current suggestions plus recent resolved history', async () => {
      const pendingId = createTestFeedItem({
        type: 'suggestion',
        source: 'claude',
        sourceId: `group-pending-${randomUUID()}`,
        title: 'Pending group suggestion',
        text: 'Pending item should stay in the group.',
        metadata: {
          suggestionType: 'code_fix',
          proposedValue: 'Keep current suggestions in the grouped card.',
          suggestionStatus: 'pending',
        },
        publishedAt: '2026-03-08T12:20:00.000Z',
      });
      const runningId = createTestFeedItem({
        type: 'suggestion',
        source: 'claude',
        sourceId: `group-running-${randomUUID()}`,
        title: 'Running group suggestion',
        text: 'Running item should stay in the group.',
        metadata: {
          suggestionType: 'code_fix',
          proposedValue: 'Keep running suggestions in the grouped card.',
          suggestionStatus: 'running',
        },
        publishedAt: '2026-03-08T12:19:00.000Z',
      });
      const mergedRecentId = createTestFeedItem({
        type: 'suggestion',
        source: 'claude',
        sourceId: `group-merged-${randomUUID()}`,
        title: 'Merged recent suggestion',
        text: 'Recent merged item should stay in bounded history.',
        metadata: {
          suggestionType: 'code_fix',
          proposedValue: 'Keep recent merged suggestions in bounded history.',
          suggestionStatus: 'merged',
        },
        publishedAt: '2026-03-08T12:18:00.000Z',
      });
      const acceptedRecentId = createTestFeedItem({
        type: 'suggestion',
        source: 'claude',
        sourceId: `group-accepted-${randomUUID()}`,
        title: 'Accepted recent suggestion',
        text: 'Recent accepted item should stay in bounded history.',
        metadata: {
          suggestionType: 'code_fix',
          proposedValue: 'Keep recent accepted suggestions in bounded history.',
          suggestionStatus: 'accepted',
        },
        publishedAt: '2026-03-08T12:17:00.000Z',
      });
      const dismissedId = createTestFeedItem({
        type: 'suggestion',
        source: 'claude',
        sourceId: `group-dismissed-${randomUUID()}`,
        title: 'Dismissed suggestion',
        text: 'Dismissed item should not stay in the group.',
        metadata: {
          suggestionType: 'code_fix',
          proposedValue: 'Dismissed suggestions should stay out of the grouped card.',
          suggestionStatus: 'dismissed',
        },
        publishedAt: '2026-03-08T12:16:00.000Z',
      });

      try {
        const response = await requestJson<FeedListResponse>('/api/feed?type=suggestion&limit=2');
        assert.strictEqual(response.status, 200);
        assertObject(response.data.suggestionGroup, 'Expected suggestionGroup payload');
        assert.strictEqual(response.data.suggestionGroup.title, 'Suggestions');
        assert.ok(Array.isArray(response.data.suggestionGroup.items), 'Expected grouped suggestion items');
        assert.strictEqual(typeof response.data.suggestionGroup.latestTimestamp, 'string');
        assert.ok(Number.isFinite(Date.parse(String(response.data.suggestionGroup.latestTimestamp))));
        assert.strictEqual(response.data.suggestionGroup.totalCount, 4);

        const groupIds = response.data.suggestionGroup.items.map((item) => item.id);
        assert.ok(groupIds.includes(pendingId));
        assert.ok(groupIds.includes(runningId));
        assert.ok(groupIds.includes(mergedRecentId));
        assert.ok(groupIds.includes(acceptedRecentId));
        assert.ok(!groupIds.includes(dismissedId));
      } finally {
        removeTestFeedItem(dismissedId);
        removeTestFeedItem(acceptedRecentId);
        removeTestFeedItem(mergedRecentId);
        removeTestFeedItem(runningId);
        removeTestFeedItem(pendingId);
      }
    });

    test('GET /api/feed returns suggestions as feed items while still hydrating them onto the parent item', async () => {
      const parentId = createTestFeedItem({
        type: 'analysis',
        source: 'claude',
        sourceId: `suggestion-parent-${randomUUID()}`,
        title: 'Pipeline Audit',
        text: 'Audit parent context',
        publishedAt: '2026-03-08T12:20:00.000Z',
      });
      const groupedSuggestionId = createTestFeedItem({
        type: 'suggestion',
        source: 'claude',
        sourceId: `grouped-suggestion-${randomUUID()}`,
        parentId,
        relationship: 'child',
        title: 'Fix queue ordering',
        text: 'Queue related fixes behind cache warmup.',
        publishedAt: '2026-03-08T12:19:00.000Z',
        metadata: {
          suggestionType: 'code_fix',
          proposedValue: 'Sequence cache warmup before queue scheduling.',
        },
      });
      const groupedSiblingSuggestionId = createTestFeedItem({
        type: 'suggestion',
        source: 'claude',
        sourceId: `grouped-suggestion-${randomUUID()}`,
        parentId,
        relationship: 'child',
        title: 'Fix retry handling',
        text: 'Reuse stale cache data on transient failures.',
        publishedAt: '2026-03-08T12:18:00.000Z',
        metadata: {
          suggestionType: 'code_fix',
          proposedValue: 'Retry stale cache reads before aborting the cycle.',
        },
      });
      const hiddenChildId = createTestFeedItem({
        type: 'article',
        source: 'bbc',
        sourceId: `hidden-child-${randomUUID()}`,
        parentId,
        relationship: 'related',
        title: 'Hidden child article',
        text: 'This child article should stay out of the feed list.',
        publishedAt: '2026-03-08T12:17:00.000Z',
      });

      try {
        const response = await requestJson<FeedListResponse>('/api/feed?type=suggestion,article,analysis&limit=50');
        assert.strictEqual(response.status, 200);

        const ids = response.data.items.map((item) => item.id);
        assert.ok(ids.includes(parentId));
        assert.ok(ids.includes(groupedSuggestionId));
        assert.ok(ids.includes(groupedSiblingSuggestionId));
        assert.ok(!ids.includes(hiddenChildId));

        const parent = response.data.items.find((item) => item.id === parentId);
        assertObject(parent, 'Expected parent item');
        assert.ok(Array.isArray(parent.suggestionChildren), 'Expected hydrated suggestionChildren on parent');
        assert.strictEqual(parent.suggestionChildren.length, 2);
        assert.strictEqual(parent.suggestionChildren[0]?.id, groupedSuggestionId);
        assert.strictEqual(parent.suggestionChildren[1]?.id, groupedSiblingSuggestionId);
      } finally {
        removeTestFeedItem(hiddenChildId);
        removeTestFeedItem(groupedSiblingSuggestionId);
        removeTestFeedItem(groupedSuggestionId);
        removeTestFeedItem(parentId);
      }
    });

    test('GET /api/feed includes children preview fields', async () => {
      const response = await requestJson<FeedListResponse>('/api/feed?limit=25');
      assert.strictEqual(response.status, 200);
      assert.ok(Array.isArray(response.data.items));

      for (const item of response.data.items) {
        assert.ok('children' in item, 'Expected children field on feed item');
        assert.ok('childrenCount' in item, 'Expected childrenCount field on feed item');
        assert.ok('parentItem' in item, 'Expected parentItem field on feed item');
        assert.ok(Array.isArray(item.children), 'Expected children to be an array');
        assert.strictEqual(typeof item.childrenCount, 'number', 'Expected childrenCount to be a number');
        assert.ok(item.children.length <= 6, 'Expected children previews to be capped at 6');
      }
    });

    test('GET /api/feed/[id] returns item + children + childrenByRelationship', async () => {
      const id = await getFeedItemId();
      const response = await requestJson(`/api/feed/${id}`);
      assert.strictEqual(response.status, 200);
      assertObject(response.data, 'Expected feed detail payload');
      assertObject(response.data.item, 'Expected item object');
      assert.ok(Array.isArray(response.data.children));
      assertObject(response.data.childrenByRelationship, 'Expected childrenByRelationship object');
    });

    test('GET /api/feed/[id] returns 404 for non-existent ID', async () => {
      const response = await requestJson('/api/feed/nonexistent-id-xyz');
      assert.strictEqual(response.status, 404);
      assertObject(response.data, 'Expected error payload');
      assert.strictEqual(response.data.error, 'Not found');
    });

    test('GET /api/feed/[id]/children returns parent + children + grouped', async () => {
      const id = await getFeedItemId();
      const response = await requestJson(`/api/feed/${id}/children`);
      assert.strictEqual(response.status, 200);
      assertObject(response.data, 'Expected feed children payload');
      assertObject(response.data.parent, 'Expected parent object');
      assert.ok(Array.isArray(response.data.children));
      assertObject(response.data.grouped, 'Expected grouped object');
    });

    test('GET /api/threads/[threadId] returns all matching rows ordered by createdAt ascending', async () => {
      const db = getDb();
      const threadId = `thread-route-${randomUUID()}`;
      const otherThreadId = `thread-route-other-${randomUUID()}`;
      const originSessionId = createValidationOriginSessionId('api-thread-route');
      const olderSourceId = `thread-route-older-${randomUUID()}`;
      const newerSourceId = `thread-route-newer-${randomUUID()}`;
      const ignoredSourceId = `thread-route-ignored-${randomUUID()}`;

      db.prepare(`
        INSERT INTO feed (
          id, type, source, source_id, origin_session_id, text, url, metadata,
          published_at, published_at_ms, created_at, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `thread-route-older-${randomUUID()}`,
        'article',
        'web',
        olderSourceId,
        originSessionId,
        'Older thread item',
        `https://example.com/${olderSourceId}`,
        JSON.stringify({ thread: { threadId, threadTitle: 'Shared conversation' } }),
        '2026-03-08T10:00:00.000Z',
        Date.parse('2026-03-08T10:00:00.000Z'),
        '2026-03-08T10:01:00.000Z',
        Date.parse('2026-03-08T10:01:00.000Z'),
      );

      db.prepare(`
        INSERT INTO feed (
          id, type, source, source_id, origin_session_id, text, url, metadata,
          published_at, published_at_ms, created_at, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `thread-route-newer-${randomUUID()}`,
        'analysis',
        'claude',
        newerSourceId,
        originSessionId,
        'Newer thread item',
        `https://example.com/${newerSourceId}`,
        JSON.stringify({ thread: { threadId, threadTitle: 'Shared conversation' } }),
        '2026-03-08T11:00:00.000Z',
        Date.parse('2026-03-08T11:00:00.000Z'),
        '2026-03-08T11:05:00.000Z',
        Date.parse('2026-03-08T11:05:00.000Z'),
      );

      db.prepare(`
        INSERT INTO feed (
          id, type, source, source_id, origin_session_id, text, url, metadata,
          published_at, published_at_ms, created_at, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `thread-route-ignored-${randomUUID()}`,
        'article',
        'web',
        ignoredSourceId,
        originSessionId,
        'Ignored thread item',
        `https://example.com/${ignoredSourceId}`,
        JSON.stringify({ thread: { threadId: otherThreadId, threadTitle: 'Other conversation' } }),
        '2026-03-08T12:00:00.000Z',
        Date.parse('2026-03-08T12:00:00.000Z'),
        '2026-03-08T12:01:00.000Z',
        Date.parse('2026-03-08T12:01:00.000Z'),
      );

      try {
        const response = await requestJson<Array<Record<string, unknown>>>(`/api/threads/${encodeURIComponent(threadId)}`);
        assert.strictEqual(response.status, 200);
        assert.ok(Array.isArray(response.data));
        assert.strictEqual(response.data.length, 2);
        assert.strictEqual(response.data[0]?.sourceId, olderSourceId);
        assert.strictEqual(response.data[1]?.sourceId, newerSourceId);
        assert.strictEqual(
          (response.data[0]?.metadata as Record<string, unknown> | undefined)?.thread
            ? ((response.data[0]?.metadata as Record<string, unknown>).thread as Record<string, unknown>).threadId
            : null,
          threadId,
        );
      } finally {
        await cleanupValidationFixtures({
          sourceIds: [olderSourceId, newerSourceId, ignoredSourceId],
          originSessionIds: [originSessionId],
        }, BASE_URL);
      }
    });

    test('PATCH /api/feed/[id] updates allowed fields in-place', async () => {
      const id = await getFeedItemId();
      const before = await requestJson(`/api/feed/${id}`);
      assert.strictEqual(before.status, 200);
      assertObject(before.data, 'Expected feed detail payload');
      assertObject(before.data.item, 'Expected item object');

      const originalUsername = typeof before.data.item.authorUsername === 'string'
        ? before.data.item.authorUsername
        : null;
      const updatedUsername = `patch-test-${Date.now()}`;

      try {
        const patchResponse = await requestJson(`/api/feed/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ author_username: updatedUsername }),
        });
        assert.strictEqual(patchResponse.status, 200);
        assertObject(patchResponse.data, 'Expected feed patch payload');
        assertObject(patchResponse.data.item, 'Expected updated item object');
        assert.strictEqual(patchResponse.data.item.authorUsername, updatedUsername);
      } finally {
        await requestJson(`/api/feed/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ author_username: originalUsername }),
        });
      }
    });

    test('PATCH /api/feed/[id] merges metadata and replaces mediaUrls', async () => {
      const id = await getFeedItemId();
      const before = await requestJson(`/api/feed/${id}`);
      assert.strictEqual(before.status, 200);
      assertObject(before.data, 'Expected feed detail payload');
      assertObject(before.data.item, 'Expected item object');

      const originalMediaUrls = Array.isArray(before.data.item.mediaUrls)
        ? before.data.item.mediaUrls.filter((entry): entry is string => typeof entry === 'string')
        : [];
      const originalMetadata = before.data.item.metadata && typeof before.data.item.metadata === 'object' && !Array.isArray(before.data.item.metadata)
        ? before.data.item.metadata as Record<string, unknown>
        : null;
      const marker = `patch-meta-${Date.now()}`;
      const updatedMediaUrls = [`https://media.test/${marker}/1.jpg`, `https://media.test/${marker}/2.jpg`];

      try {
        const firstPatch = await requestJson(`/api/feed/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            metadata: {
              article: {
                source: 'api-test',
                marker,
              },
            },
          }),
        });
        assert.strictEqual(firstPatch.status, 200);

        const secondPatch = await requestJson(`/api/feed/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            metadata: {
              linkCard: {
                type: 'article',
                url: `https://example.com/${marker}`,
                title: `Title ${marker}`,
                description: 'API test link card',
                imageUrl: `https://images.example.com/${marker}.jpg`,
                domain: 'example.com',
              },
            },
            mediaUrls: updatedMediaUrls,
          }),
        });
        assert.strictEqual(secondPatch.status, 200);
        assertObject(secondPatch.data, 'Expected feed patch payload');
        assertObject(secondPatch.data.item, 'Expected updated item object');
        assert.deepStrictEqual(secondPatch.data.item.mediaUrls, updatedMediaUrls);

        const metadata = secondPatch.data.item.metadata;
        assertObject(metadata, 'Expected merged metadata object');
        assertObject(metadata.article, 'Expected preserved article metadata');
        assert.strictEqual(metadata.article.marker, marker);
        assertObject(metadata.linkCard, 'Expected merged linkCard metadata');
        assert.strictEqual(metadata.linkCard.title, `Title ${marker}`);
      } finally {
        await requestJson(`/api/feed/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mediaUrls: originalMediaUrls,
            metadata: originalMetadata,
          }),
        });
      }
    });

    test('PATCH /api/feed/[id] rejects non-updatable fields', async () => {
      const id = await getFeedItemId();
      const response = await requestJson(`/api/feed/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'twitter' }),
      });
      assert.strictEqual(response.status, 400);
      assertObject(response.data, 'Expected patch validation error payload');
      assert.strictEqual(typeof response.data.error, 'string');
    });
  });

  describe('Config API', () => {
    test('GET /api/config returns { content } with markdown string', async () => {
      const response = await requestJson('/api/config');
      assert.strictEqual(response.status, 200);
      assertObject(response.data, 'Expected config payload');
      assert.strictEqual(typeof response.data.content, 'string');
      assert.strictEqual(response.data.readOnly, false);
      assertObject(response.data.timeZone, 'Expected config timezone payload');
      assert.strictEqual(typeof response.data.timeZone.timeZone, 'string');
      assert.ok(response.data.content.includes('#'));
    });

    test('POST /api/config with valid content returns { ok: true }', async () => {
      const isolation = requireConfigMutationIsolation();
      const original = await requestJson('/api/config');
      assert.strictEqual(original.status, 200);
      assertObject(original.data, 'Expected config payload');
      assert.strictEqual(typeof original.data.content, 'string');

      const updatedContent = `${original.data.content}\n\n<!-- api.test:${Date.now()} -->\n`;
      const historyDir = path.join(isolation.dataDir, 'config-history');
      const beforeSnapshots = new Set(await listMarkdownSnapshots(historyDir));

      try {
        const updateResponse = await requestJson('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: updatedContent }),
        });
        assert.strictEqual(updateResponse.status, 200);
        assertObject(updateResponse.data, 'Expected config update payload');
        assert.strictEqual(updateResponse.data.ok, true);

        const afterSnapshots = await listMarkdownSnapshots(historyDir);
        const newSnapshots = afterSnapshots.filter((name) => !beforeSnapshots.has(name));
        assert.ok(newSnapshots.length > 0, 'Expected config snapshot after save');

        const snapshotContent = await fs.promises.readFile(path.join(historyDir, newSnapshots.at(-1) || ''), 'utf8');
        assert.ok(snapshotContent.includes(updatedContent.trim()));
      } finally {
        await requestJson('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: original.data.content }),
        });
      }
    });

    test('GET /api/config?target=curation-prompt returns curation prompt content', async () => {
      const response = await requestJson('/api/config?target=curation-prompt');
      assert.strictEqual(response.status, 200);
      assertObject(response.data, 'Expected curation prompt payload');
      assert.strictEqual(typeof response.data.content, 'string');
      assert.strictEqual(response.data.target, 'curation-prompt');
      assert.strictEqual(response.data.path, 'data/curation-prompt.md');
      assert.strictEqual(response.data.readOnly, false);
      assert.ok(response.data.content.includes('#'));
    });

    test('POST /api/config?target=curation-prompt with valid content returns { ok: true }', async () => {
      const isolation = requireConfigMutationIsolation();
      const original = await requestJson('/api/config?target=curation-prompt');
      assert.strictEqual(original.status, 200);
      assertObject(original.data, 'Expected curation prompt payload');
      assert.strictEqual(typeof original.data.content, 'string');

      const updatedContent = `${original.data.content}\n\n<!-- api.test-curation:${Date.now()} -->\n`;
      const historyDir = path.join(isolation.dataDir, 'curation-prompt-history');
      const beforeSnapshots = new Set(await listMarkdownSnapshots(historyDir));

      try {
        const updateResponse = await requestJson('/api/config?target=curation-prompt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: updatedContent }),
        });
        assert.strictEqual(updateResponse.status, 200);
        assertObject(updateResponse.data, 'Expected curation prompt update payload');
        assert.strictEqual(updateResponse.data.ok, true);
        assert.strictEqual(updateResponse.data.target, 'curation-prompt');

        const afterSnapshots = await listMarkdownSnapshots(historyDir);
        const newSnapshots = afterSnapshots.filter((name) => !beforeSnapshots.has(name));
        assert.ok(newSnapshots.length > 0, 'Expected curation prompt snapshot after save');

        const snapshotContent = await fs.promises.readFile(path.join(historyDir, newSnapshots.at(-1) || ''), 'utf8');
        assert.ok(snapshotContent.includes(updatedContent.trim()));
      } finally {
        await requestJson('/api/config?target=curation-prompt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: original.data.content }),
        });
      }
    });

    test('POST /api/config rejects malformed full-document writes', async () => {
      requireConfigMutationIsolation();
      const updateResponse = await requestJson('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: [
            '--- data/config.md',
            '+++ data/config.md',
            '@@ -1,1 +1,1 @@',
            '+## Usage Level',
          ].join('\n'),
        }),
      });

      assert.strictEqual(updateResponse.status, 400);
      assertObject(updateResponse.data, 'Expected config error payload');
      assert.match(String(updateResponse.data.error), /unified diff markers/);
    });

    test('POST /api/internal/curate/submit rejects legacy non-code-fix suggestions', async () => {
      const response = await requestJson('/api/internal/curate/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [
            {
              id: `legacy-suggestion-${randomUUID()}`,
              type: 'suggestion',
              source: 'claude',
              sourceId: `legacy-suggestion-${randomUUID()}`,
              title: 'Legacy suggestion type',
              text: 'This should be rejected.',
              publishedAt: '2026-03-08T12:39:00.000Z',
              metadata: {
                suggestionType: 'other',
                configFile: 'data/config.md',
                proposedValue: 'Legacy payload',
              },
            },
          ],
        }),
      });

      assert.strictEqual(response.status, 200);
      assertObject(response.data, 'Expected curate submit payload');
      assert.strictEqual(response.data.inserted, 0);
      assert.strictEqual(response.data.accepted, 0);
      assert.match(String(response.data.errors?.[0]?.error), /suggestionType "code_fix"/);
    });

    test('POST /api/suggestions/batch-accept dispatches a dev agent for code_fix suggestions', async () => {
      requireConfigMutationIsolation();
      const proposedValue = 'Handle tweet-cache API degradation by retrying stale cache reads before failing the cycle.';
      const originSessionId = createValidationOriginSessionId('api-code-fix-dispatch');
      const suggestionId = createTestFeedItem({
        type: 'suggestion',
        source: 'claude',
        sourceId: `code-fix-single-${randomUUID()}`,
        title: 'Retry stale cache reads',
        text: 'Dispatch a dev agent to harden tweet-cache fallback handling.',
        originSessionId,
        publishedAt: '2026-03-08T12:39:00.000Z',
        metadata: {
          suggestionType: 'code_fix',
          proposedValue,
          originSessionId,
        },
      });

      try {
        const applyResponse = await requestJson('/api/suggestions/batch-accept', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            suggestionIds: [suggestionId],
          }),
        });

        assert.strictEqual(applyResponse.status, 200);
        assertObject(applyResponse.data, 'Expected apply-suggestion payload');
        assert.strictEqual(applyResponse.data.ok, true);
        assert.strictEqual(applyResponse.data.suggestionStatus, 'dispatched');
        const taskId = applyResponse.data.taskId;
        if (typeof taskId !== 'string') {
          throw new Error('Expected taskId to be a string');
        }
        assert.match(taskId, /^fix-retry-stale-cache-reads-\d+$/);

        const statesResponse = await requestJson<FeedListResponse>('/api/feed?type=suggestion&limit=100');
        assert.strictEqual(statesResponse.status, 200);
        const suggestion = statesResponse.data.items.find((item) => item.id === suggestionId) as Record<string, unknown>;
        assertObject(suggestion, 'Expected suggestion in feed response');
        assert.strictEqual(suggestion.suggestionStatus, 'dispatched');
        assertObject(suggestion.metadata, 'Expected suggestion metadata');
        assert.strictEqual(suggestion.metadata.taskId, taskId);
        assert.strictEqual(suggestion.metadata.suggestionStatus, 'dispatched');
        assert.strictEqual(suggestion.metadata.codeFixOrchestratorStatus, 'dispatched');

        const taskRow = getCodeFixTaskRow(taskId);
        assertObject(taskRow, 'Expected code_fix_tasks row at dispatch time');
        assert.strictEqual(taskRow.suggestionId, suggestionId);
        assert.strictEqual(taskRow.taskId, taskId);
        assert.strictEqual(taskRow.status, 'dispatched');
        assert.strictEqual(taskRow.phase, 'queued');
        assert.strictEqual(taskRow.phaseDetail, 'Queued for direct dev-task dispatch');

        const resolveResponse = await requestJson(`/api/internal/code-fix-orchestrator/resolve?taskId=${encodeURIComponent(taskId)}`);
        assert.strictEqual(resolveResponse.status, 200);
        assertObject(resolveResponse.data, 'Expected code_fix provenance resolution payload');
        assert.strictEqual(resolveResponse.data.suggestionId, suggestionId);
        assert.strictEqual(resolveResponse.data.feedItemId, suggestionId);
        assert.strictEqual(resolveResponse.data.originSessionId, originSessionId);

        // Spawning is now deferred to BrainOrchestrator — verify lifecycle still works
        await notifyCodeFixLifecycle(taskId, 'merged');
      } finally {
        removeTestFeedItem(suggestionId);
      }
    });

    test('POST /api/suggestions/batch-accept falls back to proposedValue when code_fix title is empty', async () => {
      requireConfigMutationIsolation();
      const proposedValue = 'What is broken: in src/lib/shared-browser.ts nested browser tasks are missing MCP tool access.';
      const suggestionId = createTestFeedItem({
        type: 'suggestion',
        source: 'claude',
        sourceId: `code-fix-empty-title-${randomUUID()}`,
        title: '   ',
        text: 'Dispatch a dev agent for a code-fix suggestion without a title.',
        publishedAt: '2026-03-08T12:39:00.000Z',
        metadata: {
          suggestionType: 'code_fix',
          proposedValue,
        },
      });

      try {
        const applyResponse = await requestJson('/api/suggestions/batch-accept', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            suggestionIds: [suggestionId],
          }),
        });

        assert.strictEqual(applyResponse.status, 200);
        assertObject(applyResponse.data, 'Expected apply-suggestion payload');
        assert.strictEqual(typeof applyResponse.data.taskId, 'string');
        const taskId = applyResponse.data.taskId as string;
        assert.match(taskId, /^fix-what-is-broken-in-src-lib-\d+$/);

        await notifyCodeFixLifecycle(taskId, 'merged');
      } finally {
        removeTestFeedItem(suggestionId);
      }
    });

    test('POST /api/suggestions/batch-accept dispatches non-overlapping suggestions in parallel', async () => {
      const suggestionOneId = createTestFeedItem({
        type: 'suggestion',
        source: 'claude',
        sourceId: `batch-suggestion-${randomUUID()}`,
        title: 'Tighten feed header spacing',
        text: 'Fix the feed header button spacing in the main UI.',
        publishedAt: '2026-03-08T12:39:00.000Z',
        metadata: {
          suggestionType: 'code_fix',
          proposedValue: 'Adjust the feed header button spacing in src/app/page.tsx and src/components/feed/.',
        },
      });
      const suggestionTwoId = createTestFeedItem({
        type: 'suggestion',
        source: 'claude',
        sourceId: `batch-suggestion-${randomUUID()}`,
        title: 'Add cache audit endpoint',
        text: 'Create a dedicated API route for cache audit status.',
        publishedAt: '2026-03-08T12:38:00.000Z',
        metadata: {
          suggestionType: 'code_fix',
          proposedValue: 'Add src/app/api/cache-audit/route.ts to return cache audit status.',
        },
      });

      try {
        const response = await requestJson('/api/suggestions/batch-accept', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            suggestionIds: [suggestionOneId, suggestionTwoId],
          }),
        });

        assert.strictEqual(response.status, 200);
        assertObject(response.data, 'Expected batch accept payload');
        assert.strictEqual(response.data.ok, true);
        assert.strictEqual(response.data.agentCount, 2);
        assert.strictEqual(response.data.suggestionStatus, 'dispatched');
        assert.ok(Array.isArray(response.data.taskIds));
        assert.strictEqual((response.data.taskIds as unknown[]).length, 2);
        const taskIds = (response.data.taskIds as unknown[]).filter((entry): entry is string => typeof entry === 'string');
        assert.strictEqual(taskIds.length, 2);
        taskIds.forEach((taskId) => {
          assert.match(taskId, /^fix-[a-z0-9-]+-\d+$/);
        });

        const statesResponse = await requestJson<FeedListResponse>('/api/feed?type=suggestion&limit=100');
        assert.strictEqual(statesResponse.status, 200);
        const suggestionOne = statesResponse.data.items.find((item) => item.id === suggestionOneId) as Record<string, unknown>;
        const suggestionTwo = statesResponse.data.items.find((item) => item.id === suggestionTwoId) as Record<string, unknown>;
        assertObject(suggestionOne, 'Expected first suggestion in feed response');
        assertObject(suggestionTwo, 'Expected second suggestion in feed response');
        assert.strictEqual(suggestionOne.suggestionStatus, 'dispatched');
        assert.strictEqual(suggestionTwo.suggestionStatus, 'dispatched');
        assertObject(suggestionOne.metadata, 'Expected first suggestion metadata');
        assertObject(suggestionTwo.metadata, 'Expected second suggestion metadata');
        assert.strictEqual(typeof suggestionOne.metadata.taskId, 'string');
        assert.strictEqual(typeof suggestionTwo.metadata.taskId, 'string');
        assert.notStrictEqual(suggestionOne.metadata.taskId, suggestionTwo.metadata.taskId);
        assert.strictEqual(suggestionOne.metadata.suggestionStatus, 'dispatched');
        assert.strictEqual(suggestionTwo.metadata.suggestionStatus, 'dispatched');
        assert.strictEqual(suggestionOne.metadata.codeFixOrchestratorStatus, 'dispatched');
        assert.strictEqual(suggestionTwo.metadata.codeFixOrchestratorStatus, 'dispatched');

        // Spawning is now deferred to BrainOrchestrator — verify lifecycle still works
        await Promise.all(taskIds.map((taskId) => notifyCodeFixLifecycle(taskId, 'merged')));
      } finally {
        removeTestFeedItem(suggestionTwoId);
        removeTestFeedItem(suggestionOneId);
      }
    });

    test('code-fix lifecycle updates propagate to feed suggestion status', async () => {
      requireConfigMutationIsolation();
      const suggestionId = createTestFeedItem({
        type: 'suggestion',
        source: 'claude',
        sourceId: `lifecycle-test-${randomUUID()}`,
        title: 'Fix feed scroll',
        text: 'Repair feed scroll state on the main page.',
        publishedAt: '2026-03-08T12:35:00.000Z',
        metadata: {
          suggestionType: 'code_fix',
          proposedValue: 'Fix feed scroll state in page.tsx and feed components.',
        },
      });

      try {
        const applyResponse = await requestJson('/api/suggestions/batch-accept', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            suggestionIds: [suggestionId],
          }),
        });

        assert.strictEqual(applyResponse.status, 200);
        assertObject(applyResponse.data, 'Expected apply-suggestion payload');
        assert.strictEqual(typeof applyResponse.data.taskId, 'string');
        const taskId = applyResponse.data.taskId as string;

        await notifyCodeFixLifecycle(taskId, 'failed');

        const statesResponse = await requestJson<FeedListResponse>('/api/feed?type=suggestion&limit=100');
        assert.strictEqual(statesResponse.status, 200);
        const failedSuggestion = statesResponse.data.items.find((item) => item.id === suggestionId) as Record<string, unknown>;
        assertObject(failedSuggestion, 'Expected failed suggestion in feed response');
        assert.strictEqual(failedSuggestion.suggestionStatus, 'failed');
        assertObject(failedSuggestion.metadata, 'Expected failed suggestion metadata');
        assert.strictEqual(failedSuggestion.metadata.codeFixOrchestratorStatus, 'failed');
        assert.strictEqual(failedSuggestion.metadata.taskId, taskId);
      } finally {
        removeTestFeedItem(suggestionId);
      }
    });

    test('code-fix lifecycle phase updates persist direct dispatch progress', async () => {
      requireConfigMutationIsolation();
      const suggestionId = createTestFeedItem({
        type: 'suggestion',
        source: 'claude',
        sourceId: `lifecycle-phase-${randomUUID()}`,
        title: 'Fix direct dispatch observability',
        text: 'Persist direct dispatch phases for code-fix execution.',
        publishedAt: '2026-03-08T12:35:00.000Z',
        metadata: {
          suggestionType: 'code_fix',
          proposedValue: 'Persist direct dev-task dispatch phases for code-fix execution.',
        },
      });

      try {
        const applyResponse = await requestJson('/api/suggestions/batch-accept', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            suggestionIds: [suggestionId],
          }),
        });

        assert.strictEqual(applyResponse.status, 200);
        assertObject(applyResponse.data, 'Expected apply-suggestion payload');
        assert.strictEqual(typeof applyResponse.data.taskId, 'string');
        const taskId = applyResponse.data.taskId as string;
        const dispatchResponse = await requestJson('/api/internal/code-fix-orchestrator/lifecycle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            taskId,
            phase: 'agent_dispatch',
            detail: 'Dispatched directly to dev-task pipeline',
          }),
        });
        assert.strictEqual(dispatchResponse.status, 200);

        const taskRow = getCodeFixTaskRow(taskId);
        assertObject(taskRow, 'Expected code_fix_tasks row for phase updates');
        assert.strictEqual(taskRow.phase, 'agent_dispatch');
        assert.strictEqual(taskRow.phaseDetail, 'Dispatched directly to dev-task pipeline');

        const statesResponse = await requestJson<FeedListResponse>('/api/feed?type=suggestion&limit=100');
        assert.strictEqual(statesResponse.status, 200);
        const suggestion = statesResponse.data.items.find((item) => item.id === suggestionId) as Record<string, unknown>;
        assertObject(suggestion, 'Expected suggestion in feed response');
        assertObject(suggestion.metadata, 'Expected suggestion metadata');
        assert.strictEqual(suggestion.metadata.suggestionStatus, 'pending');
      } finally {
        removeTestFeedItem(suggestionId);
      }
    });

    test('POST /api/internal/code-fix-orchestrator/cancel marks an active task cancelled and returns the suggestion to pending', async () => {
      requireConfigMutationIsolation();
      const taskId = `fix-cancel-endpoint-${randomUUID()}`;
      const reason = 'Cancelled while changing code-fix reasoning level.';
      const originSessionId = createChatSession({ title: 'Cancel origin session' }).id;
      const suggestionId = createTestFeedItem({
        type: 'suggestion',
        source: 'claude',
        sourceId: `cancel-endpoint-${randomUUID()}`,
        title: 'Cancel running code-fix',
        text: 'The running code-fix should stop and return to pending.',
        originSessionId,
        publishedAt: '2026-04-01T12:34:00.000Z',
        metadata: {
          suggestionType: 'code_fix',
          proposedValue: 'Restore the code-fix cancel endpoint.',
          originSessionId,
          suggestionStatus: 'running',
          codeFixOrchestratorStatus: 'running',
          taskId,
        },
      });

      insertCodeFixTaskRow({
        suggestionId,
        taskId,
        status: 'running',
        phase: 'agent_dispatch',
        phaseDetail: 'Running before cancellation',
      });

      try {
        const response = await requestJson('/api/internal/code-fix-orchestrator/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            suggestionId,
            taskId,
            reason,
          }),
        });

        assert.strictEqual(response.status, 200);
        assertObject(response.data, 'Expected cancel payload');
        assert.strictEqual(response.data.ok, true);
        assert.strictEqual(response.data.cancelled, true);
        assert.deepStrictEqual(response.data.taskIds, [taskId]);
        assert.deepStrictEqual(response.data.suggestionIds, [suggestionId]);

        const taskRow = getCodeFixTaskRow(taskId);
        assertObject(taskRow, 'Expected cancelled code_fix_tasks row');
        assert.strictEqual(taskRow.status, 'cancelled');
        assert.strictEqual(taskRow.phase, 'cancelled');
        assert.strictEqual(taskRow.phaseDetail, reason);
        assert.strictEqual(typeof taskRow.completedAt, 'string');

        const statesResponse = await requestJson<FeedListResponse>('/api/feed?type=suggestion&limit=100');
        assert.strictEqual(statesResponse.status, 200);
        const suggestion = statesResponse.data.items.find((item) => item.id === suggestionId) as Record<string, unknown>;
        assertObject(suggestion, 'Expected cancelled suggestion in feed response');
        assert.strictEqual(suggestion.suggestionStatus, 'pending');
        assertObject(suggestion.metadata, 'Expected cancelled suggestion metadata');
        assert.strictEqual(suggestion.metadata.suggestionStatus, 'pending');
        assert.strictEqual(suggestion.metadata.codeFixOrchestratorStatus, 'cancelled');
        assert.strictEqual(suggestion.metadata.codeFixCancellationReason, reason);

        const chatRow = getDb().prepare(`
          SELECT role, type, task_id AS taskId, status, text, metadata
          FROM chat_messages
          WHERE session_id = ?
            AND text LIKE ?
          ORDER BY created_at DESC
          LIMIT 1
        `).get(originSessionId, `Code-fix task ${taskId}%`) as Record<string, unknown> | undefined;
        assertObject(chatRow, 'Expected cancellation note in origin chat session');
        assert.strictEqual(chatRow.role, 'agent');
        assert.strictEqual(chatRow.type, 'chat');
        assert.strictEqual(chatRow.taskId, taskId);
        assert.strictEqual(chatRow.status, 'delivered');
        assert.match(String(chatRow.text), new RegExp(taskId));
        assert.match(String(chatRow.text), new RegExp(suggestionId));
        assert.match(String(chatRow.text), new RegExp(reason));
        assert.match(String(chatRow.text), /The suggestion is now pending\./);

        const chatMetadata = JSON.parse(String(chatRow.metadata || '{}')) as Record<string, unknown>;
        assert.strictEqual(chatMetadata.taskId, taskId);
        assert.strictEqual(chatMetadata.suggestionId, suggestionId);
        assert.strictEqual(chatMetadata.status, 'cancelled');
        assert.strictEqual(chatMetadata.phase, 'cancelled');
      } finally {
        const db = getDb();
        db.prepare('DELETE FROM chat_messages WHERE session_id = ?').run(originSessionId);
        db.prepare('DELETE FROM chat_session_brain_settings WHERE session_id = ?').run(originSessionId);
        db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(originSessionId);
        removeTestFeedItem(suggestionId);
      }
    });

    test('POST /api/internal/code-fix-orchestrator/cancel is a no-op when no active task matches', async () => {
      requireConfigMutationIsolation();
      const suggestionId = createTestFeedItem({
        type: 'suggestion',
        source: 'claude',
        sourceId: `cancel-noop-${randomUUID()}`,
        title: 'Cancel inactive code-fix',
        text: 'Cancelling with no active task should succeed without changes.',
        publishedAt: '2026-04-01T12:34:30.000Z',
        metadata: {
          suggestionType: 'code_fix',
          proposedValue: 'No active task exists for this suggestion.',
          suggestionStatus: 'pending',
        },
      });

      try {
        const response = await requestJson('/api/internal/code-fix-orchestrator/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ suggestionId }),
        });

        assert.strictEqual(response.status, 200);
        assertObject(response.data, 'Expected cancel no-op payload');
        assert.strictEqual(response.data.ok, true);
        assert.strictEqual(response.data.cancelled, false);
        assert.deepStrictEqual(response.data.taskIds, []);
        assert.deepStrictEqual(response.data.suggestionIds, []);
      } finally {
        removeTestFeedItem(suggestionId);
      }
    });

    test('POST /api/internal/code-fix-suggestions/sync cancels active code-fix tasks when a suggestion is dismissed', async () => {
      requireConfigMutationIsolation();
      const primaryTaskId = `fix-sync-dismiss-${randomUUID()}`;
      const retryTaskId = `${primaryTaskId}-v2`;
      const suggestionId = createTestFeedItem({
        type: 'suggestion',
        source: 'claude',
        sourceId: `sync-dismiss-${randomUUID()}`,
        title: 'Dismiss overlapping verified-state fix',
        text: 'The older verified-state fix should be dismissed and cancelled.',
        publishedAt: '2026-04-01T12:35:00.000Z',
        metadata: {
          suggestionType: 'code_fix',
          proposedValue: 'Cancel stale overlapping verified-state fixes when they are dismissed.',
          suggestionStatus: 'running',
          codeFixOrchestratorStatus: 'running',
          taskId: retryTaskId,
        },
      });

      insertCodeFixTaskRow({
        suggestionId,
        taskId: primaryTaskId,
        status: 'running',
        phase: 'agent_dispatch',
        phaseDetail: 'First attempt still running',
      });
      insertCodeFixTaskRow({
        suggestionId,
        taskId: retryTaskId,
        status: 'dispatched',
        phase: 'queued',
        phaseDetail: 'Replacement attempt queued',
      });

      try {
        const response = await requestJson('/api/internal/code-fix-suggestions/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            suggestions: [
              {
                id: suggestionId,
                suggestionStatus: 'dismissed',
              },
            ],
          }),
        });

        assert.strictEqual(response.status, 200);

        const statesResponse = await requestJson<FeedListResponse>('/api/feed?type=suggestion&limit=100');
        assert.strictEqual(statesResponse.status, 200);
        const suggestion = statesResponse.data.items.find((item) => item.id === suggestionId) as Record<string, unknown>;
        assertObject(suggestion, 'Expected dismissed suggestion in feed response');
        assert.strictEqual(suggestion.suggestionStatus, 'dismissed');
        assertObject(suggestion.metadata, 'Expected dismissed suggestion metadata');
        assert.strictEqual(suggestion.metadata.codeFixOrchestratorStatus, 'dismissed');

        const primaryTaskRow = getCodeFixTaskRow(primaryTaskId);
        const retryTaskRow = getCodeFixTaskRow(retryTaskId);
        assertObject(primaryTaskRow, 'Expected primary code_fix_tasks row');
        assertObject(retryTaskRow, 'Expected retry code_fix_tasks row');
        assert.strictEqual(primaryTaskRow.status, 'cancelled');
        assert.strictEqual(retryTaskRow.status, 'cancelled');
        assert.strictEqual(primaryTaskRow.phase, 'cancelled');
        assert.strictEqual(retryTaskRow.phase, 'cancelled');
        assert.match(String(primaryTaskRow.phaseDetail), /dismissed/i);
        assert.match(String(retryTaskRow.phaseDetail), /dismissed/i);
      } finally {
        removeTestFeedItem(suggestionId);
      }
    });

    test('POST /api/interactions cancels active code-fix tasks when dismissing a suggestion', async () => {
      requireConfigMutationIsolation();
      const taskId = `fix-dismiss-interaction-${randomUUID()}`;
      const suggestionId = createTestFeedItem({
        type: 'suggestion',
        source: 'claude',
        sourceId: `dismiss-interaction-${randomUUID()}`,
        title: 'Dismiss active code-fix suggestion',
        text: 'Dismissing the suggestion should cancel the active dev task.',
        publishedAt: '2026-04-01T12:36:00.000Z',
        metadata: {
          suggestionType: 'code_fix',
          proposedValue: 'Cancel active code-fix tasks when the suggestion is dismissed from the feed.',
          suggestionStatus: 'running',
          codeFixOrchestratorStatus: 'running',
          taskId,
        },
      });

      insertCodeFixTaskRow({
        suggestionId,
        taskId,
        status: 'running',
        phase: 'agent_dispatch',
        phaseDetail: 'Running before dismissal',
      });

      try {
        const response = await requestJson('/api/interactions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            feedItemId: suggestionId,
            action: 'dismiss_suggestion',
          }),
        });

        assert.strictEqual(response.status, 200);
        assertObject(response.data, 'Expected dismiss interaction payload');
        assert.strictEqual(response.data.ok, true);
        assert.strictEqual(response.data.suggestionStatus, 'dismissed');

        const taskRow = getCodeFixTaskRow(taskId);
        assertObject(taskRow, 'Expected code_fix_tasks row after dismissal');
        assert.strictEqual(taskRow.status, 'cancelled');
        assert.strictEqual(taskRow.phase, 'cancelled');
        assert.match(String(taskRow.phaseDetail), /dismissed/i);

        const statesResponse = await requestJson<FeedListResponse>('/api/feed?type=suggestion&limit=100');
        assert.strictEqual(statesResponse.status, 200);
        const suggestion = statesResponse.data.items.find((item) => item.id === suggestionId) as Record<string, unknown>;
        assertObject(suggestion, 'Expected dismissed suggestion in feed response');
        assert.strictEqual(suggestion.suggestionStatus, 'dismissed');
        assertObject(suggestion.metadata, 'Expected dismissed suggestion metadata');
        assert.strictEqual(suggestion.metadata.codeFixOrchestratorStatus, 'dismissed');
      } finally {
        removeTestFeedItem(suggestionId);
      }
    });

    test('code-fix log endpoint returns 404 when no agent log exists', async () => {
      requireConfigMutationIsolation();
      const suggestionId = createTestFeedItem({
        type: 'suggestion',
        source: 'claude',
        sourceId: `startup-logs-${randomUUID()}`,
        title: 'Return 404 for missing code-fix logs',
        text: 'Code-fix logs should only come from real agent task logs.',
        publishedAt: '2026-03-08T12:35:00.000Z',
        metadata: {
          suggestionType: 'code_fix',
          proposedValue: 'Return 404 when no code-fix agent log exists.',
        },
      });

      try {
        const applyResponse = await requestJson('/api/suggestions/batch-accept', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            suggestionIds: [suggestionId],
          }),
        });

        assert.strictEqual(applyResponse.status, 200);
        assertObject(applyResponse.data, 'Expected apply-suggestion payload');
        assert.strictEqual(typeof applyResponse.data.taskId, 'string');
        const taskId = applyResponse.data.taskId as string;

        const logsResponse = await requestJson(`/api/internal/code-fix-orchestrator/logs/${encodeURIComponent(taskId)}?lines=20`);
        assert.strictEqual(logsResponse.status, 404);
        assertObject(logsResponse.data, 'Expected logs payload');
        assert.strictEqual(logsResponse.data.ok, false);
        assert.match(String(logsResponse.data.error), /Log file not found/);
      } finally {
        removeTestFeedItem(suggestionId);
      }
    });

    test('terminal unrecoverable code-fix failures create one pending repair suggestion without auto-enqueueing it', async () => {
      requireConfigMutationIsolation();
      const suggestionId = createTestFeedItem({
        type: 'suggestion',
        source: 'claude',
        sourceId: `repair-incident-${randomUUID()}`,
        title: 'Fix provider mismatch handling',
        text: 'Dispatch a dev agent to repair provider mismatch handling.',
        publishedAt: '2026-03-08T12:35:00.000Z',
        metadata: {
          suggestionType: 'code_fix',
          proposedValue: 'Repair provider mismatch handling in the dev-agent dispatch path.',
        },
      });

      let repairSuggestionId: string | null = null;
      try {
        const applyResponse = await requestJson('/api/suggestions/batch-accept', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            suggestionIds: [suggestionId],
          }),
        });

        assert.strictEqual(applyResponse.status, 200);
        assertObject(applyResponse.data, 'Expected apply-suggestion payload');
        assert.strictEqual(typeof applyResponse.data.taskId, 'string');
        const taskId = applyResponse.data.taskId as string;

        const failureResponse = await requestJson('/api/internal/code-fix-tasks/failure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            taskId,
            status: 'failed',
            phase: 'agent_execution',
            error: 'codex: command not found',
            logTail: 'bash: line 1: codex: command not found',
          }),
        });

        assert.strictEqual(failureResponse.status, 200);
        assertObject(failureResponse.data, 'Expected failure payload');
        assertObject(failureResponse.data.classification, 'Expected failure classification');
        assert.strictEqual(failureResponse.data.classification.incidentKey, 'dev-agent:provider-binary-missing:codex');
        assert.strictEqual(failureResponse.data.classification.autoRepairEligible, true);
        assertObject(failureResponse.data.repair, 'Expected repair payload');
        assert.strictEqual(typeof failureResponse.data.repair.suggestionId, 'string');
        repairSuggestionId = failureResponse.data.repair.suggestionId as string;
        assert.strictEqual(failureResponse.data.repair.taskId, null);
        assert.strictEqual(failureResponse.data.repair.status, 'pending');

        const repeatedFailureResponse = await requestJson('/api/internal/code-fix-tasks/failure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            taskId,
            status: 'failed',
            phase: 'agent_execution',
            error: 'codex: command not found',
            logTail: 'bash: line 1: codex: command not found',
          }),
        });

        assert.strictEqual(repeatedFailureResponse.status, 200);
        assertObject(repeatedFailureResponse.data, 'Expected repeated failure payload');
        assertObject(repeatedFailureResponse.data.repair, 'Expected repeated repair payload');
        assert.strictEqual(repeatedFailureResponse.data.repair.suggestionId, repairSuggestionId);
        assert.strictEqual(repeatedFailureResponse.data.repair.taskId, null);
        assert.strictEqual(repeatedFailureResponse.data.repair.status, 'pending');

        const statesResponse = await requestJson<FeedListResponse>('/api/feed?type=suggestion&limit=100');
        assert.strictEqual(statesResponse.status, 200);
        const failedSuggestion = statesResponse.data.items.find((item) => item.id === suggestionId) as Record<string, unknown>;
        const repairSuggestion = statesResponse.data.items.find((item) => item.id === repairSuggestionId) as Record<string, unknown>;
        assertObject(failedSuggestion, 'Expected failed suggestion in feed response');
        assertObject(repairSuggestion, 'Expected repair suggestion in feed response');
        assert.strictEqual(failedSuggestion.suggestionStatus, 'failed');
        assertObject(failedSuggestion.metadata, 'Expected failed suggestion metadata');
        assertObject(failedSuggestion.metadata.codeFixFailure, 'Expected explicit failure metadata');
        assert.strictEqual(failedSuggestion.metadata.codeFixFailure.incidentKey, 'dev-agent:provider-binary-missing:codex');
        assert.match(String(failedSuggestion.metadata.codeFixFailure.evidence || ''), /codex: command not found/);
        assertObject(failedSuggestion.metadata.codeFixFailure.repair, 'Expected repair link metadata');
        assert.strictEqual(failedSuggestion.metadata.codeFixFailure.repair.suggestionId, repairSuggestionId);
        assert.strictEqual(failedSuggestion.metadata.codeFixFailure.repair.taskId, null);
        assert.strictEqual(failedSuggestion.metadata.codeFixFailure.repair.status, 'pending');

        assert.strictEqual(repairSuggestion.suggestionStatus, 'pending');
        assertObject(repairSuggestion.metadata, 'Expected repair suggestion metadata');
        assert.strictEqual(repairSuggestion.metadata.repairCoordinator, true);
        assert.strictEqual(repairSuggestion.metadata.incidentKey, 'dev-agent:provider-binary-missing:codex');
        assert.deepStrictEqual(getCodeFixTaskRowsForSuggestion(repairSuggestionId), []);
      } finally {
        if (repairSuggestionId) {
          removeTestFeedItem(repairSuggestionId);
        }
        removeTestFeedItem(suggestionId);
      }
    });

    test('code-fix terminal failure endpoint rejects retryable lifecycle updates', async () => {
      requireConfigMutationIsolation();
      const suggestionId = createTestFeedItem({
        type: 'suggestion',
        source: 'claude',
        sourceId: `failure-contract-${randomUUID()}`,
        title: 'Keep retryable failures off the terminal failure path',
        text: 'Dispatch a dev agent and keep retryable errors on lifecycle updates.',
        publishedAt: '2026-03-08T12:35:00.000Z',
        metadata: {
          suggestionType: 'code_fix',
          proposedValue: 'Repair dev-agent failure reporting contract drift.',
        },
      });

      try {
        const applyResponse = await requestJson('/api/suggestions/batch-accept', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            suggestionIds: [suggestionId],
          }),
        });

        assert.strictEqual(applyResponse.status, 200);
        assertObject(applyResponse.data, 'Expected apply-suggestion payload');
        assert.strictEqual(typeof applyResponse.data.taskId, 'string');

        const failureResponse = await requestJson('/api/internal/code-fix-tasks/failure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            taskId: applyResponse.data.taskId,
            status: 'running',
            phase: 'retry_pending',
            error: 'Attempt 1/3 failed; retry pending',
          }),
        });

        assert.strictEqual(failureResponse.status, 409);
        assertObject(failureResponse.data, 'Expected failure payload');
        assert.match(String(failureResponse.data.error), /use .*code-fix-orchestrator\/lifecycle/i);

        const statesResponse = await requestJson<FeedListResponse>('/api/feed?type=suggestion&limit=100');
        assert.strictEqual(statesResponse.status, 200);
        const suggestion = statesResponse.data.items.find((item) => item.id === suggestionId) as Record<string, unknown>;
        assertObject(suggestion, 'Expected suggestion in feed response');
        assert.notStrictEqual(suggestion.suggestionStatus, 'failed');
        assertObject(suggestion.metadata, 'Expected suggestion metadata');
        assert.ok(!suggestion.metadata.codeFixFailure, 'Retryable updates must not stamp terminal failure metadata');
      } finally {
        removeTestFeedItem(suggestionId);
      }
    });

    test('terminal failure resolution follows historical code-fix task ids without clobbering the latest attempt pointer', async () => {
      requireConfigMutationIsolation();
      const originalTaskId = `fix-historical-contract-${randomUUID()}`;
      const retryTaskId = `${originalTaskId}-v2`;
      const suggestionId = createTestFeedItem({
        type: 'suggestion',
        source: 'claude',
        sourceId: `historical-task-${randomUUID()}`,
        title: 'Repair task-family resolution drift',
        text: 'Terminal failure reports should resolve through code_fix_tasks history.',
        publishedAt: '2026-03-08T12:35:00.000Z',
        metadata: {
          suggestionType: 'code_fix',
          proposedValue: 'Repair dev-agent task resolution when lifecycle and failure reports reference non-current task ids.',
          suggestionStatus: 'running',
          codeFixOrchestratorStatus: 'running',
          taskId: retryTaskId,
          codeFixTaskFamily: originalTaskId,
          codeFixAttemptNumber: 2,
          codeFixPreviousTaskId: originalTaskId,
        },
      });

      let repairSuggestionId: string | null = null;
      try {
        insertCodeFixTaskRow({
          suggestionId,
          taskId: originalTaskId,
          status: 'failed',
          phase: 'retry_pending',
          phaseDetail: 'Attempt 1/3 failed; retry 2/3 pending',
        });
        insertCodeFixTaskRow({
          suggestionId,
          taskId: retryTaskId,
          status: 'running',
          phase: 'agent_dispatch',
          phaseDetail: 'Replacement attempt is active',
        });

        const failureResponse = await requestJson('/api/internal/code-fix-tasks/failure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            taskId: originalTaskId,
            status: 'failed',
            phase: 'agent_execution',
            error: 'codex: command not found',
            logTail: 'bash: line 1: codex: command not found',
          }),
        });

        assert.strictEqual(failureResponse.status, 200);
        assertObject(failureResponse.data, 'Expected failure payload');
        assert.strictEqual(failureResponse.data.taskId, retryTaskId);
        assertObject(failureResponse.data.resolution, 'Expected task resolution payload');
        assert.strictEqual(failureResponse.data.resolution.reportedTaskId, originalTaskId);
        assert.strictEqual(failureResponse.data.resolution.suggestionTaskId, retryTaskId);
        assert.strictEqual(failureResponse.data.resolution.matchedVia, 'code_fix_task_history');
        assertObject(failureResponse.data.classification, 'Expected failure classification');
        assert.strictEqual(failureResponse.data.classification.incidentKey, 'dev-agent:provider-binary-missing:codex');

        assertObject(failureResponse.data.repair, 'Expected repair payload');
        repairSuggestionId = typeof failureResponse.data.repair.suggestionId === 'string'
          ? failureResponse.data.repair.suggestionId
          : null;
        assert.strictEqual(failureResponse.data.repair.taskId, null);
        assert.strictEqual(failureResponse.data.repair.status, 'pending');

        const statesResponse = await requestJson<FeedListResponse>('/api/feed?type=suggestion&limit=100');
        assert.strictEqual(statesResponse.status, 200);
        const failedSuggestion = statesResponse.data.items.find((item) => item.id === suggestionId) as Record<string, unknown>;
        assertObject(failedSuggestion, 'Expected failed suggestion in feed response');
        assertObject(failedSuggestion.metadata, 'Expected failed suggestion metadata');
        assert.strictEqual(failedSuggestion.metadata.taskId, retryTaskId);
        assertObject(failedSuggestion.metadata.codeFixFailure, 'Expected failure metadata');
        assert.strictEqual(failedSuggestion.metadata.codeFixFailure.incidentKey, 'dev-agent:provider-binary-missing:codex');

        const originalTaskRow = getCodeFixTaskRow(originalTaskId);
        const retryTaskRow = getCodeFixTaskRow(retryTaskId);
        assertObject(originalTaskRow, 'Expected historical code_fix_tasks row');
        assertObject(retryTaskRow, 'Expected current code_fix_tasks row');
        assert.strictEqual(originalTaskRow.status, 'failed');
        assert.strictEqual(retryTaskRow.taskId, retryTaskId);
        if (repairSuggestionId) {
          assert.deepStrictEqual(getCodeFixTaskRowsForSuggestion(repairSuggestionId), []);
        }
      } finally {
        if (repairSuggestionId) {
          removeTestFeedItem(repairSuggestionId);
        }
        removeTestFeedItem(suggestionId);
      }
    });

    test('transient code-fix failures do not auto-dispatch repair agents', async () => {
      requireConfigMutationIsolation();
      const suggestionId = createTestFeedItem({
        type: 'suggestion',
        source: 'claude',
        sourceId: `transient-failure-${randomUUID()}`,
        title: 'Fix flaky test coverage',
        text: 'Dispatch a dev agent to fix a flaky test.',
        publishedAt: '2026-03-08T12:35:00.000Z',
        metadata: {
          suggestionType: 'code_fix',
          proposedValue: 'Fix the flaky test without changing runtime behavior.',
        },
      });

      try {
        const applyResponse = await requestJson('/api/suggestions/batch-accept', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            suggestionIds: [suggestionId],
          }),
        });

        assert.strictEqual(applyResponse.status, 200);
        assertObject(applyResponse.data, 'Expected apply-suggestion payload');
        assert.strictEqual(typeof applyResponse.data.taskId, 'string');

        const failureResponse = await requestJson('/api/internal/code-fix-tasks/failure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            taskId: applyResponse.data.taskId,
            status: 'failed',
            phase: 'pipeline',
            error: 'FAIL: Tests failed',
            logTail: 'npm run test\nFAIL: Tests failed',
          }),
        });

        assert.strictEqual(failureResponse.status, 200);
        assertObject(failureResponse.data, 'Expected failure payload');
        assertObject(failureResponse.data.classification, 'Expected failure classification');
        assert.strictEqual(failureResponse.data.classification.autoRepairEligible, false);
        assert.strictEqual(failureResponse.data.repair, null);

        const statesResponse = await requestJson<FeedListResponse>('/api/feed?type=suggestion&limit=100');
        assert.strictEqual(statesResponse.status, 200);
        const failedSuggestion = statesResponse.data.items.find((item) => item.id === suggestionId) as Record<string, unknown>;
        assertObject(failedSuggestion, 'Expected failed suggestion in feed response');
        assertObject(failedSuggestion.metadata, 'Expected failed suggestion metadata');
        assertObject(failedSuggestion.metadata.codeFixFailure, 'Expected failure metadata');
        assert.strictEqual(failedSuggestion.metadata.codeFixFailure.autoRepairEligible, false);
        const linkedRepair = failedSuggestion.metadata.codeFixFailure.repair;
        assert.ok(linkedRepair === null || linkedRepair.suggestionId === null);
      } finally {
        removeTestFeedItem(suggestionId);
      }
    });

    test('POST /api/suggestions/batch-accept rejects non-code-fix suggestions', async () => {
      const suggestionId = createTestFeedItem({
        type: 'suggestion',
        source: 'claude',
        sourceId: `batch-invalid-${randomUUID()}`,
        title: 'Adjust config',
        text: 'Switch usage level to high.',
        metadata: {
          suggestionType: 'other',
          proposedValue: 'High',
        },
      });

      try {
        const response = await requestJson('/api/suggestions/batch-accept', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            suggestionIds: [suggestionId],
          }),
        });

        assert.strictEqual(response.status, 400);
        assertObject(response.data, 'Expected error payload');
        assert.match(String(response.data.error), /suggestionType=code_fix/);
      } finally {
        removeTestFeedItem(suggestionId);
      }
    });

    test('GET /api/config?target=curate rejects retired curate command content', async () => {
      const response = await requestJson('/api/config?target=curate');
      assert.strictEqual(response.status, 400);
      assertObject(response.data, 'Expected invalid target payload');
      assert.match(String(response.data.error), /Invalid target/);
    });

    test('GET /api/config?target=reflect-command returns read-only reflect command content', async () => {
      const response = await requestJson('/api/config?target=reflect-command');
      assert.strictEqual(response.status, 200);
      assertObject(response.data, 'Expected reflect command payload');
      assert.strictEqual(typeof response.data.content, 'string');
      assert.strictEqual(response.data.target, 'reflect-command');
      assert.strictEqual(response.data.path, '.claude/commands/reflect.md');
      assert.strictEqual(response.data.readOnly, true);
      assert.ok(response.data.content.includes('Run one full reflection cycle in this invocation.'));
    });

    test('GET /api/config?target=enrichment returns combined read-only enrichment instructions', async () => {
      const response = await requestJson('/api/config?target=enrichment');
      assert.strictEqual(response.status, 200);
      assertObject(response.data, 'Expected enrichment instructions payload');
      assert.strictEqual(typeof response.data.content, 'string');
      assert.strictEqual(response.data.target, 'enrichment-instructions');
      assert.strictEqual(response.data.path, '.claude/commands/intake-enrich.md + src/app/api/feed/[id]/enrich/route.ts');
      assert.strictEqual(response.data.readOnly, true);
      assert.ok(response.data.content.includes('# Enrichment Instructions'));
      assert.ok(response.data.content.includes('## Intake Enrichment (deterministic)'));
      assert.ok(response.data.content.includes('Run deterministic intake enrichment for recent feed items.'));
      assert.ok(response.data.content.includes('## Post Detail Enrichment (agent-based)'));
      assert.ok(response.data.content.includes('You are a post enrichment sub-agent.'));
      assert.ok(response.data.content.includes('MAIN tweet URL for reply fetches: ${mainTweetUrl}'));
      assert.ok(response.data.content.includes('NEVER fetch replies for a quoted tweet URL found in metadata.'));
      assert.ok(response.data.content.includes('If a reply is addressed to someone else or starts with an @-mention other than ${mainTweetAuthorHandle}, it may be a reply to the quoted tweet. Skip it.'));
      assert.ok(response.data.content.includes('Finish only after JSONL lines have been appended.'));
    });

    test('GET /api/config?target=runtime-instructions returns read-only CLAUDE instructions', async () => {
      const response = await requestJson('/api/config?target=runtime-instructions');
      assert.strictEqual(response.status, 200);
      assertObject(response.data, 'Expected runtime instructions payload');
      assert.strictEqual(typeof response.data.content, 'string');
      assert.strictEqual(response.data.target, 'runtime-instructions');
      assert.strictEqual(response.data.path, 'CLAUDE.md');
      assert.strictEqual(response.data.readOnly, true);
    });

    test('GET /api/config?target=chat-instructions returns extracted read-only chat instructions', async () => {
      const response = await requestJson('/api/config?target=chat-instructions');
      assert.strictEqual(response.status, 200);
      assertObject(response.data, 'Expected chat instructions payload');
      assert.strictEqual(typeof response.data.content, 'string');
      assert.strictEqual(response.data.target, 'chat-instructions');
      assert.strictEqual(response.data.path, 'CLAUDE.md');
      assert.strictEqual(response.data.readOnly, true);
      assert.ok(response.data.content.includes('# Chat Agent Instructions'));
      assert.ok(response.data.content.includes('**Model:** Claude Opus 4.7'));
      assert.ok(response.data.content.includes('Exact user-owned settings in gitignored `data/config.md` may be edited directly'));
      assert.ok(response.data.content.includes('## Chat JSONL Schema'));
      assert.ok(response.data.content.includes('review currently pending `code_fix` suggestions for the same problem or topic'));
      assert.ok(response.data.content.includes('update, supersede, or dismiss the older overlapping suggestion first'));
      assert.ok(response.data.content.includes('### Chat Architecture Awareness'));
      assert.ok(!response.data.content.includes('## Reflection Rules'));
    });

    test('GET /api/config?target=insights returns read-only preference insights content', async () => {
      const response = await requestJson('/api/config?target=insights');
      assert.strictEqual(response.status, 200);
      assertObject(response.data, 'Expected preference insights payload');
      assert.strictEqual(typeof response.data.content, 'string');
      assert.strictEqual(response.data.target, 'preference-insights');
      assert.strictEqual(response.data.path, 'data/preference-insights.md');
      assert.strictEqual(response.data.readOnly, true);
      assert.ok(response.data.content.includes('# No preference insights yet'));
    });

    test('GET /api/config?target=preferences returns read-only preferences context', async () => {
      const response = await requestJson('/api/config?target=preferences');
      assert.strictEqual(response.status, 200);
      assertObject(response.data, 'Expected preferences payload');
      assert.strictEqual(typeof response.data.content, 'string');
      assert.strictEqual(response.data.target, 'preferences');
      assert.strictEqual(response.data.path, 'data/preferences-context.md');
      assert.strictEqual(response.data.readOnly, true);
    });

    test('GET /api/config?target=cache-hints returns structured cache hints when the file exists', async () => {
      const filePath = getDataPath('cache-hints.json');
      const restore = await preserveFile(filePath);

      try {
        await fs.promises.writeFile(filePath, JSON.stringify({
          updatedAt: '2026-03-17T10:15:00.000Z',
          updatedBy: 'curate-20260317-101500',
          accounts: [
            { handle: 'alice', includeReplies: true },
            { handle: '@bob', includeReplies: false },
          ],
          searches: ['longevity research', 'grid interconnection'],
        }, null, 2));

        const response = await requestJson('/api/config?target=cache-hints');
        assert.strictEqual(response.status, 200);
        assertObject(response.data, 'Expected cache hints payload');
        assert.strictEqual(typeof response.data.content, 'string');
        assert.strictEqual(response.data.target, 'cache-hints');
        assert.strictEqual(response.data.path, 'data/cache-hints.json');
        assert.strictEqual(response.data.readOnly, true);
        assertObject(response.data.cacheHints, 'Expected structured cache hints');
        assert.strictEqual(response.data.cacheHints.state, 'available');
        assert.strictEqual(response.data.cacheHints.updatedAt, '2026-03-17T10:15:00.000Z');
        assert.strictEqual(response.data.cacheHints.updatedBy, 'curate-20260317-101500');
        assert.deepStrictEqual(response.data.cacheHints.accounts, [
          { handle: 'alice', includeReplies: true },
          { handle: 'bob', includeReplies: false },
        ]);
        assert.deepStrictEqual(response.data.cacheHints.searches, ['longevity research', 'grid interconnection']);
      } finally {
        await restore();
      }
    });

    test('GET /api/config?target=cache-hints returns a missing-state payload when the file does not exist', async () => {
      const filePath = getDataPath('cache-hints.json');
      const restore = await preserveFile(filePath);

      try {
        await fs.promises.rm(filePath, { force: true });

        const response = await requestJson('/api/config?target=cache-hints');
        assert.strictEqual(response.status, 200);
        assertObject(response.data, 'Expected cache hints payload');
        assert.strictEqual(response.data.target, 'cache-hints');
        assert.strictEqual(response.data.path, 'data/cache-hints.json');
        assert.strictEqual(response.data.readOnly, true);
        assert.strictEqual(response.data.content, '');
        assertObject(response.data.cacheHints, 'Expected cache hints state');
        assert.strictEqual(response.data.cacheHints.state, 'missing');
        assert.deepStrictEqual(response.data.cacheHints.accounts, []);
        assert.deepStrictEqual(response.data.cacheHints.searches, []);
      } finally {
        await restore();
      }
    });

    test('GET /api/config?target=skills returns read-only combined skills content', async () => {
      const response = await requestJson('/api/config?target=skills');
      assert.strictEqual(response.status, 200);
      assertObject(response.data, 'Expected skills payload');
      assert.strictEqual(typeof response.data.content, 'string');
      assert.strictEqual(response.data.target, 'skills');
      assert.strictEqual(response.data.path, '.claude/skills/');
      assert.strictEqual(response.data.readOnly, true);
    });

    test('POST /api/config rejects writes to read-only targets', async () => {
      requireConfigMutationIsolation();
      const response = await requestJson('/api/config?target=runtime-instructions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '# no-op' }),
      });
      assert.strictEqual(response.status, 403);
      assertObject(response.data, 'Expected read-only rejection payload');
      assert.strictEqual(response.data.error, 'This config is read-only');
    });
  });

  describe('Ping API', () => {
    test('POST /api/ping returns { ok, enqueued, requestId, queueDepth }', async () => {
      const response = await requestJson('/api/ping', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'test ping' }),
      });
      assert.strictEqual(response.status, 200);
      assertObject(response.data, 'Expected ping payload');
      assert.strictEqual(typeof response.data.ok, 'boolean');
      assert.strictEqual(typeof response.data.enqueued, 'boolean');
      assert.strictEqual(typeof response.data.requestId, 'string');
      assert.strictEqual(typeof response.data.queueDepth, 'number');
    });
  });

  describe('Status API', () => {
    test('GET /api/status returns sessionExists, working, orchestrator fields', async () => {
      const response = await requestJson('/api/status');
      assert.strictEqual(response.status, 200);
      assertObject(response.data, 'Expected status payload');
      assert.strictEqual(typeof response.data.sessionExists, 'boolean');
      assert.strictEqual(typeof response.data.working, 'boolean');
      assert.ok('orchestrator' in response.data);
    });

    test('GET /api/brain-provider returns current provider state and availability details', async () => {
      const response = await requestJson('/api/brain-provider');
      assert.strictEqual(response.status, 200);
      assertObject(response.data, 'Expected brain provider payload');
      assert.ok(response.data.currentProvider === 'claude' || response.data.currentProvider === 'codex');
      assert.ok(response.data.currentProviderLabel === 'Claude Code' || response.data.currentProviderLabel === 'Codex CLI');
      assert.ok(
        response.data.codexReasoningEffort === 'low'
        || response.data.codexReasoningEffort === 'medium'
        || response.data.codexReasoningEffort === 'high',
      );
      assertObject(response.data.providers, 'Expected providers payload');
      assertObject(response.data.providers.claude, 'Expected Claude availability payload');
      assertObject(response.data.providers.codex, 'Expected Codex availability payload');
      assert.strictEqual(typeof response.data.providers.claude.available, 'boolean');
      assert.strictEqual(typeof response.data.providers.codex.available, 'boolean');
      assert.strictEqual(typeof response.data.isProcessing, 'boolean');
    });
  });

  describe('Chat API', () => {
    test('GET /api/chat/messages returns { items, count }', async () => {
      const response = await requestJson('/api/chat/messages');
      assert.strictEqual(response.status, 200);
      assertObject(response.data, 'Expected chat list payload');
      assert.ok(Array.isArray(response.data.items));
      assert.strictEqual(typeof response.data.count, 'number');
    });

    test('GET /api/chat/messages?limit=5 respects limit', async () => {
      const response = await requestJson('/api/chat/messages?limit=5');
      assert.strictEqual(response.status, 200);
      assertObject(response.data, 'Expected chat list payload');
      assert.ok(Array.isArray(response.data.items));
      assert.ok(response.data.items.length <= 5);
      assert.strictEqual(response.data.count, response.data.items.length);
    });

    test('GET /api/chat/sessions paginates persisted session history', async () => {
      const firstSession = createChatSession({ title: 'First session' });
      const secondSession = createChatSession({ title: 'Second session' });

      insertChatMessage({
        id: 'api-chat-sessions-first',
        role: 'user',
        sessionId: firstSession.id,
        text: 'first session message',
        timestamp: '2026-03-01T10:00:00.000Z',
        status: 'delivered',
      });
      insertChatMessage({
        id: 'api-chat-sessions-second',
        role: 'user',
        sessionId: secondSession.id,
        text: 'second session message',
        timestamp: '2026-03-02T10:00:00.000Z',
        status: 'delivered',
      });

      const response = await requestJson('/api/chat/sessions?limit=1&offset=0');
      assert.strictEqual(response.status, 200);
      assertObject(response.data, 'Expected session page payload');
      assert.ok(Array.isArray(response.data.sessions));
      assert.strictEqual(response.data.count, 1);
      assert.strictEqual(typeof response.data.totalCount, 'number');
      assert.strictEqual(typeof response.data.hasMore, 'boolean');
      assert.strictEqual(response.data.sessions[0]?.sessionId, secondSession.id);
      assert.strictEqual(response.data.sessions[0]?.messageCount, 1);
    });

    test('GET /api/chat/messages supports loading one session without relying on the recent message window', async () => {
      const olderSession = createChatSession({ title: 'Older session' });

      insertChatMessage({
        id: 'api-chat-session-filter-1',
        role: 'user',
        sessionId: olderSession.id,
        text: 'older session first message',
        timestamp: '2026-03-01T08:00:00.000Z',
        status: 'delivered',
      });
      insertChatMessage({
        id: 'api-chat-session-filter-2',
        role: 'agent',
        sessionId: olderSession.id,
        text: 'older session reply',
        timestamp: '2026-03-01T08:01:00.000Z',
        status: 'delivered',
      });

      const response = await requestJson(`/api/chat/messages?sessionId=${encodeURIComponent(olderSession.id)}&limit=10`);
      assert.strictEqual(response.status, 200);
      assertObject(response.data, 'Expected filtered chat payload');
      assert.ok(Array.isArray(response.data.items));
      assert.strictEqual(response.data.items.length, 2);
      assert.strictEqual(response.data.totalCount, 2);
      assert.strictEqual(response.data.hasMore, false);
      assert.ok(response.data.items.every((item: { sessionId?: string | null }) => item.sessionId === olderSession.id));
    });

    test('POST /api/chat with { message: "test" } returns 202 with enqueued=true', async () => {
      const response = await requestJson('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'test' }),
      });
      assert.strictEqual(response.status, 202);
      assertObject(response.data, 'Expected chat enqueue payload');
      assert.strictEqual(response.data.enqueued, true);
      assert.strictEqual(typeof response.data.requestId, 'string');
      assert.strictEqual(typeof response.data.queueDepth, 'number');
    });

    test('POST /api/chat honors an existing non-UUID session id', async () => {
      const db = getDb();
      const existingSessionId = 'legacy-session';
      const moreRecentSession = createChatSession();

      db.prepare(`
        INSERT OR REPLACE INTO chat_sessions (id, provider, provider_session_id, claude_session_id, title, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        existingSessionId,
        'claude',
        existingSessionId,
        existingSessionId,
        'Main',
        '2026-03-01T00:00:00.000Z',
        '2026-03-01T00:00:00.000Z',
      );

      db.prepare(`
        UPDATE chat_sessions
        SET updated_at = ?
        WHERE id = ?
      `).run('2026-03-02T00:00:00.000Z', moreRecentSession.id);

      const response = await requestJson('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'send this to the main conversation',
          sessionId: existingSessionId,
        }),
      });

      assert.strictEqual(response.status, 202);
      assertObject(response.data, 'Expected chat enqueue payload');
      assert.strictEqual(response.data.sessionId, existingSessionId);
      const { userMessage } = response.data;
      assertObject(userMessage, 'Expected queued user message');
      assert.strictEqual(userMessage.sessionId, existingSessionId);

      const storedMessage = db.prepare(`
        SELECT session_id
        FROM chat_messages
        WHERE id = ?
      `).get(userMessage.id) as { session_id?: string } | undefined;
      assert.strictEqual(storedMessage?.session_id, existingSessionId);
    });

    test('POST /api/chat enables browser-tool metadata for curator sessions only', async () => {
      const curatorSession = createChatSession({
        provider: 'claude',
        sessionType: 'curator',
        title: 'Curator Session',
      });
      const normalSession = createChatSession({
        provider: 'claude',
        title: 'Normal Session',
      });

      const curatorResponse = await requestJson('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'check sama on x',
          sessionId: curatorSession.id,
        }),
      });

      const normalResponse = await requestJson('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'check sama on x',
          sessionId: normalSession.id,
        }),
      });

      assert.strictEqual(curatorResponse.status, 202);
      assert.strictEqual(normalResponse.status, 202);
      assertObject(curatorResponse.data, 'Expected curator chat enqueue payload');
      assertObject(normalResponse.data, 'Expected normal chat enqueue payload');

      const curatorTask = await waitForOrchestratorTask(curatorResponse.data.requestId);
      const normalTask = await waitForOrchestratorTask(normalResponse.data.requestId);

      assertObject(curatorTask.metadata, 'Expected curator task metadata');
      assert.strictEqual(curatorTask.metadata.sessionType, 'curator');
      assert.strictEqual(curatorTask.metadata.requiresBrowserTools, true);

      assertObject(normalTask.metadata, 'Expected normal task metadata');
      assert.ok(!Object.hasOwn(normalTask.metadata, 'requiresBrowserTools'));
      assert.notStrictEqual(normalTask.metadata.requiresBrowserTools, true);
    });

    test('POST /api/chat keeps the selected session provider after the global brain changes', async () => {
      requireConfigMutationIsolation();
      const originalConfig = await requestJson('/api/config');
      assert.strictEqual(originalConfig.status, 200);
      assertObject(originalConfig.data, 'Expected config payload');
      assert.strictEqual(typeof originalConfig.data.content, 'string');

      try {
        const codexConfigContent = updateBrainConfigContent(originalConfig.data.content, {
          provider: 'codex',
          codexReasoningEffort: 'medium',
        });
        const configResponse = await requestJson('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: codexConfigContent }),
        });
        assert.strictEqual(configResponse.status, 200);

        const session = createChatSession({
          provider: 'claude',
          title: 'Claude Session',
        });

        const response = await requestJson('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: 'keep this in the existing Claude conversation',
            sessionId: session.id,
          }),
        });

        assert.strictEqual(response.status, 202);
        assertObject(response.data, 'Expected chat enqueue payload');
        assert.strictEqual(response.data.sessionId, session.id);
        assert.strictEqual(response.data.userMessage.sessionId, session.id);
        assert.strictEqual(typeof response.data.requestId, 'string');

        const task = await waitForOrchestratorTask(response.data.requestId);
        assertObject(task.metadata, 'Expected queued task metadata');
        assert.strictEqual(task.metadata.sessionId, session.id);
        assert.strictEqual(task.metadata.provider, 'claude');
      } finally {
        await requestJson('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: originalConfig.data.content }),
        });
      }
    });

    test('POST /api/chat/upload saves allowed files and GET /api/chat/upload returns preview content', async () => {
      const formData = new FormData();
      formData.set('file', new Blob(['attachment body'], { type: 'text/plain' }), 'notes.txt');

      const uploadResponse = await fetch(`${BASE_URL}/api/chat/upload`, {
        method: 'POST',
        body: formData,
      });
      const uploadData = await uploadResponse.json() as Record<string, unknown>;

      assert.strictEqual(uploadResponse.status, 201);
      assertObject(uploadData, 'Expected upload payload');
      assert.strictEqual(typeof uploadData.filePath, 'string');
      assert.strictEqual(typeof uploadData.previewUrl, 'string');
      assert.strictEqual(typeof uploadData.fileName, 'string');
      assert.strictEqual(uploadData.originalName, 'notes.txt');

      const savedPath = uploadData.filePath as string;

      try {
        assert.strictEqual(await fs.promises.readFile(savedPath, 'utf8'), 'attachment body');

        const previewResponse = await fetch(`${BASE_URL}${uploadData.previewUrl as string}`);
        assert.strictEqual(previewResponse.status, 200);
        assert.match(previewResponse.headers.get('content-type') || '', /^text\/plain/i);
        assert.strictEqual(await previewResponse.text(), 'attachment body');
      } finally {
        await fs.promises.rm(savedPath, { force: true });
      }
    });

    test('POST /api/chat/upload rejects unsupported file types', async () => {
      const formData = new FormData();
      formData.set('file', new Blob(['bad'], { type: 'application/octet-stream' }), 'malware.exe');

      const response = await fetch(`${BASE_URL}/api/chat/upload`, {
        method: 'POST',
        body: formData,
      });
      const payload = await response.json() as Record<string, unknown>;

      assert.strictEqual(response.status, 415);
      assertObject(payload, 'Expected upload error payload');
      assert.strictEqual(payload.error, 'Unsupported file type');
    });

    test('POST /api/chat/sessions creates a session immediately with an optional custom title', async () => {
      const response = await requestJson('/api/chat/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Morning Dispatch',
          color: 'teal',
          workingDirectory: '/root/my-project',
        }),
      });

      assert.strictEqual(response.status, 201);
      assertObject(response.data, 'Expected create session payload');
      assert.strictEqual(response.data.ok, true);
      assertObject(response.data.session, 'Expected session payload');
      assert.ok(response.data.session.provider === 'claude' || response.data.session.provider === 'codex');
      assert.strictEqual(response.data.session.title, 'Morning Dispatch');
      assert.strictEqual(response.data.session.color, 'teal');
      assert.strictEqual(response.data.session.workingDirectory, '/root/my-project');
      assert.ok(Array.isArray(response.data.sessions));
      assert.ok(response.data.sessions.some((session) => (
        session
        && typeof session === 'object'
        && session.sessionId === response.data.session.id
        && (session.provider === 'claude' || session.provider === 'codex')
        && session.title === 'Morning Dispatch'
        && session.color === 'teal'
        && session.workingDirectory === '/root/my-project'
      )));
    });

    test('POST /api/chat/sessions accepts sessionType=curator', async () => {
      const response = await requestJson('/api/chat/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Iran-only curator',
          sessionType: 'curator',
        }),
      });

      assert.strictEqual(response.status, 201);
      assertObject(response.data, 'Expected create session payload');
      assertObject(response.data.session, 'Expected session payload');
      assert.strictEqual(response.data.session.sessionType, 'curator');

      const row = getDb().prepare(`
        SELECT session_type
        FROM chat_sessions
        WHERE id = ?
      `).get(response.data.session.id) as { session_type?: string | null } | undefined;

      assert.strictEqual(row?.session_type, 'curator');
    });

    test('POST /api/chat/sessions accepts an explicit provider', async () => {
      const response = await requestJson('/api/chat/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Codex Session',
          provider: 'codex',
          codexReasoningEffort: 'medium',
        }),
      });

      assert.strictEqual(response.status, 201);
      assertObject(response.data, 'Expected create session payload');
      assertObject(response.data.session, 'Expected session payload');
      assert.strictEqual(response.data.session.provider, 'codex');
      assert.strictEqual(response.data.session.codexReasoningEffort, 'medium');
      assert.ok(Array.isArray(response.data.sessions));
      assert.ok(response.data.sessions.some((session) => (
        session
        && typeof session === 'object'
        && session.sessionId === response.data.session.id
        && session.provider === 'codex'
        && session.codexReasoningEffort === 'medium'
      )));
    });

    test('POST /api/chat/sessions accepts Claude reasoning effort', async () => {
      const response = await requestJson('/api/chat/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Claude Session',
          provider: 'claude',
          claudeReasoningEffort: 'max',
        }),
      });

      assert.strictEqual(response.status, 201);
      assertObject(response.data, 'Expected create session payload');
      assertObject(response.data.session, 'Expected session payload');
      assert.strictEqual(response.data.session.provider, 'claude');
      assert.strictEqual(response.data.session.claudeReasoningEffort, 'max');
      assert.ok(Array.isArray(response.data.sessions));
      assert.ok(response.data.sessions.some((session) => (
        session
        && typeof session === 'object'
        && session.sessionId === response.data.session.id
        && session.provider === 'claude'
        && session.claudeReasoningEffort === 'max'
      )));
    });

    test('PATCH /api/chat/sessions/[sessionId] updates Codex reasoning and the next chat turn keeps the same session', async () => {
      requireConfigMutationIsolation();
      const originalConfig = await requestJson('/api/config');
      assert.strictEqual(originalConfig.status, 200);
      assertObject(originalConfig.data, 'Expected config payload');
      assert.strictEqual(typeof originalConfig.data.content, 'string');

      try {
        const codexConfigContent = updateBrainConfigContent(originalConfig.data.content, {
          provider: 'codex',
          codexReasoningEffort: 'medium',
        });
        const configResponse = await requestJson('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: codexConfigContent }),
        });
        assert.strictEqual(configResponse.status, 200);

        const session = createChatSession({
          provider: 'codex',
          codexReasoningEffort: 'medium',
          title: 'Codex Reasoning Test',
        });

        const updateResponse = await requestJson(`/api/chat/sessions/${encodeURIComponent(session.id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ codexReasoningEffort: 'xhigh', codexFastMode: true }),
        });

        assert.strictEqual(updateResponse.status, 200);
        assertObject(updateResponse.data, 'Expected update session payload');
        assert.strictEqual(updateResponse.data.ok, true);
        assertObject(updateResponse.data.session, 'Expected updated session summary');
        assert.strictEqual(updateResponse.data.session.sessionId, session.id);
        assert.strictEqual(updateResponse.data.session.codexReasoningEffort, 'xhigh');
        assert.strictEqual(updateResponse.data.session.codexFastMode, true);
        assert.ok(Array.isArray(updateResponse.data.sessions));
        assert.ok(updateResponse.data.sessions.some((entry) => (
          entry
          && typeof entry === 'object'
          && entry.sessionId === session.id
          && entry.codexReasoningEffort === 'xhigh'
          && entry.codexFastMode === true
        )));

        const chatResponse = await requestJson('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: 'use the updated reasoning for this session',
            sessionId: session.id,
          }),
        });

        assert.strictEqual(chatResponse.status, 202);
        assertObject(chatResponse.data, 'Expected chat enqueue payload');
        assert.strictEqual(chatResponse.data.sessionId, session.id);
        assert.strictEqual(chatResponse.data.userMessage.sessionId, session.id);
        assert.strictEqual(typeof chatResponse.data.requestId, 'string');

        const task = await waitForOrchestratorTask(chatResponse.data.requestId);
        assertObject(task.metadata, 'Expected queued task metadata');
        assert.strictEqual(task.metadata.sessionId, session.id);
        assert.strictEqual(task.metadata.codexReasoningEffort, 'xhigh');
        assert.strictEqual(task.metadata.codexFastMode, true);
      } finally {
        await requestJson('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: originalConfig.data.content }),
        });
      }
    });

    test('PATCH /api/chat/sessions/[sessionId] updates Claude reasoning and the next chat turn keeps the same session', async () => {
      const session = createChatSession({
        provider: 'claude',
        claudeReasoningEffort: 'high',
        title: 'Claude Reasoning Test',
      });

      const updateResponse = await requestJson(`/api/chat/sessions/${encodeURIComponent(session.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ claudeReasoningEffort: 'xhigh' }),
      });

      assert.strictEqual(updateResponse.status, 200);
      assertObject(updateResponse.data, 'Expected update session payload');
      assert.strictEqual(updateResponse.data.ok, true);
      assertObject(updateResponse.data.session, 'Expected updated session summary');
      assert.strictEqual(updateResponse.data.session.sessionId, session.id);
      assert.strictEqual(updateResponse.data.session.claudeReasoningEffort, 'xhigh');
      assert.ok(Array.isArray(updateResponse.data.sessions));
      assert.ok(updateResponse.data.sessions.some((entry) => (
        entry
        && typeof entry === 'object'
        && entry.sessionId === session.id
        && entry.claudeReasoningEffort === 'xhigh'
      )));

      const chatResponse = await requestJson('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'use the updated Claude reasoning for this session',
          sessionId: session.id,
        }),
      });

      assert.strictEqual(chatResponse.status, 202);
      assertObject(chatResponse.data, 'Expected chat enqueue payload');
      assert.strictEqual(chatResponse.data.sessionId, session.id);
      assert.strictEqual(chatResponse.data.userMessage.sessionId, session.id);
      assert.strictEqual(typeof chatResponse.data.requestId, 'string');

      const task = await waitForOrchestratorTask(chatResponse.data.requestId);
      assertObject(task.metadata, 'Expected queued task metadata');
      assert.strictEqual(task.metadata.sessionId, session.id);
      assert.strictEqual(task.metadata.claudeReasoningEffort, 'xhigh');
    });

    test('PATCH /api/chat/sessions/[sessionId] updates session metadata without requiring Codex reasoning', async () => {
      const session = createChatSession({
        title: 'Unsorted',
        color: 'blue',
        workingDirectory: '/root/evogent',
      });

      const response = await requestJson(`/api/chat/sessions/${encodeURIComponent(session.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Docs Review',
          color: 'green',
          workingDirectory: '/root/evogent/docs',
        }),
      });

      assert.strictEqual(response.status, 200);
      assertObject(response.data, 'Expected update session payload');
      assert.strictEqual(response.data.ok, true);
      assertObject(response.data.session, 'Expected updated session summary');
      assert.strictEqual(response.data.session.sessionId, session.id);
      assert.strictEqual(response.data.session.title, 'Docs Review');
      assert.strictEqual(response.data.session.color, 'green');
      assert.strictEqual(response.data.session.workingDirectory, '/root/evogent/docs');
      assert.ok(Array.isArray(response.data.sessions));
      assert.ok(response.data.sessions.some((entry) => (
        entry
        && typeof entry === 'object'
        && entry.sessionId === session.id
        && entry.title === 'Docs Review'
        && entry.color === 'green'
        && entry.workingDirectory === '/root/evogent/docs'
      )));
    });

    test('PATCH /api/chat/sessions/[sessionId] updates sessionType', async () => {
      const session = createChatSession({
        title: 'General Chat',
      });

      const response = await requestJson(`/api/chat/sessions/${encodeURIComponent(session.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionType: 'curator',
        }),
      });

      assert.strictEqual(response.status, 200);
      assertObject(response.data, 'Expected update session payload');
      assert.strictEqual(response.data.session.sessionType, 'curator');
    });

    test('POST /api/internal/browse-cache/submit stores cache rows and GET /api/internal/browse-cache/items reads them back', async () => {
      const sourceId = `hn-${randomUUID()}`;
      const startedAtMs = Date.now() - 5000;
      const completedAtMs = Date.now();

      const submitResponse = await requestJson('/api/internal/browse-cache/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: 'hackernews',
          triggeredBy: 'api-test',
          startedAtMs,
          completedAtMs,
          status: 'completed',
          items: [
            {
              source: 'hackernews',
              sourceId,
              url: `https://example.com/${sourceId}`,
              title: 'Cached HN story',
              authorUsername: 'pg',
              authorDisplayName: 'Paul Graham',
              publishedAtMs: startedAtMs,
              fetchedAtMs: completedAtMs,
              expiresAtMs: completedAtMs + 60_000,
              payload: {
                sourceId,
                title: 'Cached HN story',
                score: 42,
              },
            },
          ],
        }),
      });

      assert.strictEqual(submitResponse.status, 200);
      assertObject(submitResponse.data, 'Expected browse cache submit payload');
      assert.strictEqual(submitResponse.data.ok, true);
      assertObject(submitResponse.data.run, 'Expected browse cache run');
      assert.strictEqual(submitResponse.data.run.source, 'hackernews');

      const itemsResponse = await requestJson(`/api/internal/browse-cache/items?source=hackernews&freshAfterMs=${completedAtMs - 1}&limit=20`);
      assert.strictEqual(itemsResponse.status, 200);
      assertObject(itemsResponse.data, 'Expected browse cache items payload');
      assert.strictEqual(itemsResponse.data.ok, true);
      assert.ok(Array.isArray(itemsResponse.data.items));

      const cachedItem = itemsResponse.data.items.find((item: Record<string, unknown>) => item.sourceId === sourceId) as Record<string, unknown> | undefined;
      assertObject(cachedItem, 'Expected cached browse item');
      assert.strictEqual(cachedItem.source, 'hackernews');
      assert.strictEqual(cachedItem.title, 'Cached HN story');
    });

    test('POST /api/internal/browse-cache/seen marks documented items and unseenFirst prioritizes unseen rows', async () => {
      const now = Date.now();
      const twitterIds = {
        unseenNewest: `tweet-unseen-newest-${randomUUID()}`,
        seenNewest: `tweet-seen-newest-${randomUUID()}`,
        unseenOlder: `tweet-unseen-older-${randomUUID()}`,
        seenOlder: `tweet-seen-older-${randomUUID()}`,
      };
      const youtubeIds = {
        newer: `yt-seen-newer-${randomUUID()}`,
        older: `yt-seen-older-${randomUUID()}`,
      };

      const submitResponse = await requestJson('/api/internal/browse-cache/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: 'twitter',
          triggeredBy: 'api-test',
          startedAtMs: now - 5_000,
          completedAtMs: now - 4_000,
          status: 'completed',
          items: [
            {
              source: 'twitter',
              sourceId: twitterIds.unseenNewest,
              title: 'unseen newest',
              publishedAtMs: now - 1_000,
              fetchedAtMs: now - 900,
              expiresAtMs: now + 60_000,
              payload: { id: twitterIds.unseenNewest },
            },
            {
              source: 'twitter',
              sourceId: twitterIds.seenNewest,
              title: 'seen newest',
              publishedAtMs: now - 2_000,
              fetchedAtMs: now - 1_900,
              expiresAtMs: now + 60_000,
              payload: { id: twitterIds.seenNewest },
            },
            {
              source: 'twitter',
              sourceId: twitterIds.unseenOlder,
              title: 'unseen older',
              publishedAtMs: now - 3_000,
              fetchedAtMs: now - 2_900,
              expiresAtMs: now + 60_000,
              payload: { id: twitterIds.unseenOlder },
            },
            {
              source: 'twitter',
              sourceId: twitterIds.seenOlder,
              title: 'seen older',
              publishedAtMs: now - 4_000,
              fetchedAtMs: now - 3_900,
              expiresAtMs: now + 60_000,
              payload: { id: twitterIds.seenOlder },
            },
            {
              source: 'youtube',
              sourceId: youtubeIds.newer,
              title: 'youtube seen newer',
              publishedAtMs: now - 1_500,
              fetchedAtMs: now - 1_400,
              expiresAtMs: now + 60_000,
              payload: { id: youtubeIds.newer },
            },
            {
              source: 'youtube',
              sourceId: youtubeIds.older,
              title: 'youtube seen older',
              publishedAtMs: now - 2_500,
              fetchedAtMs: now - 2_400,
              expiresAtMs: now + 60_000,
              payload: { id: youtubeIds.older },
            },
          ],
        }),
      });
      assert.strictEqual(submitResponse.status, 200);

      const seenResponse = await requestJson('/api/internal/browse-cache/seen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [
            { source: 'twitter', sourceId: twitterIds.seenNewest },
            { source: 'twitter', sourceId: twitterIds.seenOlder },
            { source: 'youtube', sourceId: youtubeIds.newer },
            { source: 'youtube', sourceId: youtubeIds.older },
          ],
        }),
      });

      assert.strictEqual(seenResponse.status, 200);
      assertObject(seenResponse.data, 'Expected browse cache seen payload');
      assert.strictEqual(seenResponse.data.ok, true);
      assert.strictEqual(seenResponse.data.changed, 4);

      const defaultOrderResponse = await requestJson('/api/internal/browse-cache/items?source=twitter&limit=4');
      assert.strictEqual(defaultOrderResponse.status, 200);
      assertObject(defaultOrderResponse.data, 'Expected default-order browse cache items payload');
      assert.deepStrictEqual(
        defaultOrderResponse.data.items.map((item: Record<string, unknown>) => item.sourceId),
        [
          twitterIds.unseenNewest,
          twitterIds.seenNewest,
          twitterIds.unseenOlder,
          twitterIds.seenOlder,
        ],
      );

      const unseenFirstResponse = await requestJson('/api/internal/browse-cache/items?source=twitter&limit=4&unseenFirst=true');
      assert.strictEqual(unseenFirstResponse.status, 200);
      assertObject(unseenFirstResponse.data, 'Expected unseenFirst browse cache items payload');
      assert.deepStrictEqual(
        unseenFirstResponse.data.items.map((item: Record<string, unknown>) => item.sourceId),
        [
          twitterIds.unseenNewest,
          twitterIds.unseenOlder,
          twitterIds.seenNewest,
          twitterIds.seenOlder,
        ],
      );
      assert.strictEqual(unseenFirstResponse.data.items[0].seenByCurationAtMs, null);
      assert.strictEqual(unseenFirstResponse.data.items[1].seenByCurationAtMs, null);
      assert.ok(typeof unseenFirstResponse.data.items[2].seenByCurationAtMs === 'number');
      assert.ok(typeof unseenFirstResponse.data.items[3].seenByCurationAtMs === 'number');

      const seenOnlyResponse = await requestJson('/api/internal/browse-cache/items?source=youtube&limit=5&unseenFirst=true');
      assert.strictEqual(seenOnlyResponse.status, 200);
      assertObject(seenOnlyResponse.data, 'Expected seen-only browse cache items payload');
      assert.strictEqual(seenOnlyResponse.data.items.length, 2);
      assert.deepStrictEqual(
        seenOnlyResponse.data.items.map((item: Record<string, unknown>) => item.sourceId),
        [youtubeIds.newer, youtubeIds.older],
      );
      assert.ok(seenOnlyResponse.data.items.every((item: Record<string, unknown>) => typeof item.seenByCurationAtMs === 'number'));
    });

    test('POST /api/chat persists attachment metadata on the user message', async () => {
      const filePath = getDataPath('chat-attachments', `attachment-api-${randomUUID()}.txt`);
      const fileName = path.basename(filePath);
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.writeFile(filePath, 'saved attachment', 'utf8');

      try {
        const response = await requestJson('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: 'Analyze the attached text file.',
            attachments: [
              {
                filePath,
                fileName,
                originalName: 'notes.txt',
                previewUrl: `/api/chat/upload?file=${encodeURIComponent(fileName)}`,
                contentType: 'text/plain',
                size: 16,
                kind: 'document',
              },
            ],
          }),
        });

        assert.strictEqual(response.status, 202);
        assertObject(response.data, 'Expected chat enqueue payload');
        assertObject(response.data.userMessage, 'Expected user message payload');
        assertObject(response.data.userMessage.metadata, 'Expected user message metadata');
        assert.ok(Array.isArray(response.data.userMessage.metadata.attachments));
        assert.strictEqual(response.data.userMessage.metadata.attachments.length, 1);
        assert.strictEqual(response.data.userMessage.metadata.attachments[0].filePath, filePath);
        assert.strictEqual(response.data.userMessage.metadata.attachments[0].previewUrl, `/api/chat/upload?file=${encodeURIComponent(fileName)}`);
      } finally {
        await fs.promises.rm(filePath, { force: true });
      }
    });

    test('POST /api/chat/sessions/[sessionId]/reset clears messages but keeps the session', async () => {
      const session = createChatSession();
      insertChatMessage({
        id: `reset-msg-${randomUUID()}`,
        role: 'user',
        sessionId: session.id,
        text: 'clear this conversation',
        status: 'delivered',
      });

      const response = await requestJson(`/api/chat/sessions/${encodeURIComponent(session.id)}/reset`, {
        method: 'POST',
      });

      assert.strictEqual(response.status, 200);
      assertObject(response.data, 'Expected reset session payload');
      assert.strictEqual(response.data.ok, true);
      assert.strictEqual(response.data.sessionId, session.id);
      assert.ok(Array.isArray(response.data.sessions));

      const db = getDb();
      const remainingMessages = db.prepare(`
        SELECT COUNT(*) AS count
        FROM chat_messages
        WHERE session_id = ?
      `).get(session.id) as { count: number };
      assert.strictEqual(remainingMessages.count, 0);

      const storedSession = db.prepare(`
        SELECT provider, provider_session_id, claude_session_id
        FROM chat_sessions
        WHERE id = ?
      `).get(session.id) as {
        provider?: string;
        provider_session_id?: string;
        claude_session_id?: string;
      } | undefined;
      assert.ok(storedSession);
      assert.strictEqual(storedSession?.provider, 'claude');
      assert.notStrictEqual(storedSession?.provider_session_id, session.providerSessionId);
      assert.notStrictEqual(storedSession?.claude_session_id, session.claudeSessionId);
    });

    test('DELETE /api/chat/sessions/[sessionId] removes the session and returns the next selection', async () => {
      const firstSession = createChatSession();
      const secondSession = createChatSession();

      insertChatMessage({
        id: `delete-msg-${randomUUID()}`,
        role: 'user',
        sessionId: secondSession.id,
        text: 'delete this conversation',
        status: 'delivered',
      });

      const response = await requestJson(`/api/chat/sessions/${encodeURIComponent(secondSession.id)}`, {
        method: 'DELETE',
      });

      assert.strictEqual(response.status, 200);
      assertObject(response.data, 'Expected delete session payload');
      assert.strictEqual(response.data.ok, true);
      assert.strictEqual(response.data.sessionId, secondSession.id);
      assert.strictEqual(response.data.nextSessionId, firstSession.id);
      assert.ok(Array.isArray(response.data.sessions));

      const db = getDb();
      const deletedSession = db.prepare(`
        SELECT id
        FROM chat_sessions
        WHERE id = ?
      `).get(secondSession.id);
      assert.strictEqual(deletedSession, undefined);
    });
  });

  describe('Agents API', () => {
    test('GET /api/agents returns { agents, count }', async () => {
      const response = await requestJson('/api/agents');
      assert.strictEqual(response.status, 200);
      assertObject(response.data, 'Expected agents payload');
      assert.ok(Array.isArray(response.data.agents));
      assert.strictEqual(typeof response.data.count, 'number');
    });

    test('GET /api/agents/nonexistent returns 404', async () => {
      const response = await requestJson('/api/agents/nonexistent');
      assert.strictEqual(response.status, 404);
      assertObject(response.data, 'Expected agent error payload');
    });

    test('DELETE /api/agents/nonexistent returns 404', async () => {
      const response = await requestJson('/api/agents/nonexistent', { method: 'DELETE' });
      assert.strictEqual(response.status, 404);
      assertObject(response.data, 'Expected agent delete error payload');
    });

    test('GET /api/agents/transcript returns assistant text from JSONL logs', async () => {
      const filePath = getDataPath('agent-logs', `api-test-transcript-${Date.now()}.jsonl`);
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });

      const lines = [
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'First assistant message.' },
            ],
          },
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', name: 'search' },
              { type: 'text', text: 'Second assistant message.' },
            ],
          },
        }),
        JSON.stringify({
          type: 'user',
          message: {
            content: [
              { type: 'text', text: 'This line should not be included.' },
            ],
          },
        }),
      ];

      await fs.promises.writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');

      try {
        const response = await requestJson(`/api/agents/transcript?file=${encodeURIComponent(filePath)}`);
        assert.strictEqual(response.status, 200);
        assertObject(response.data, 'Expected transcript payload');
        assert.strictEqual(response.data.transcript, 'First assistant message.\n\nSecond assistant message.');
        assert.strictEqual(response.data.assistantMessageCount, 2);
      } finally {
        await fs.promises.rm(filePath, { force: true });
      }
    });

    test('GET /api/agents/transcript accepts orchestrator task log files', async () => {
      const filePath = getDataPath('task-logs', `api-test-task-transcript-${Date.now()}.jsonl`);
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });

      await fs.promises.writeFile(filePath, `${JSON.stringify({
        type: 'assistant',
        content: [
          { type: 'text', text: 'Persisted curation transcript line.' },
        ],
      })}\n`, 'utf8');

      try {
        const response = await requestJson(`/api/agents/transcript?file=${encodeURIComponent(filePath)}`);
        assert.strictEqual(response.status, 200);
        assertObject(response.data, 'Expected transcript payload');
        assert.strictEqual(response.data.transcript, 'Persisted curation transcript line.');
        assert.strictEqual(response.data.assistantMessageCount, 1);
      } finally {
        await fs.promises.rm(filePath, { force: true });
      }
    });

    test('GET /api/agents/transcript returns Codex agent messages from JSONL logs', async () => {
      const filePath = getDataPath('agent-logs', `api-test-codex-transcript-${Date.now()}.jsonl`);
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });

      const lines = [
        JSON.stringify({ type: 'thread.started', thread_id: randomUUID() }),
        JSON.stringify({
          type: 'item.started',
          item: {
            id: 'item_1',
            type: 'command_execution',
            command: '/bin/zsh -lc "echo hello"',
          },
        }),
        JSON.stringify({
          type: 'item.completed',
          item: {
            id: 'item_2',
            type: 'agent_message',
            text: 'First Codex assistant message.',
          },
        }),
        JSON.stringify({
          type: 'item.completed',
          item: {
            id: 'item_3',
            type: 'agent_message',
            text: 'Second Codex assistant message.',
          },
        }),
      ];

      await fs.promises.writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');

      try {
        const response = await requestJson(`/api/agents/transcript?file=${encodeURIComponent(filePath)}`);
        assert.strictEqual(response.status, 200);
        assertObject(response.data, 'Expected transcript payload');
        assert.strictEqual(response.data.transcript, 'First Codex assistant message.\n\nSecond Codex assistant message.');
        assert.strictEqual(response.data.assistantMessageCount, 2);
      } finally {
        await fs.promises.rm(filePath, { force: true });
      }
    });
  });

  describe('Activity API', () => {
    test('POST /api/activity with app_open returns { ok, logged, heartbeat }', async () => {
      const response = await requestJson('/api/activity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'app_open' }),
      });
      assert.strictEqual(response.status, 200);
      assertObject(response.data, 'Expected activity payload');
      assert.strictEqual(response.data.ok, true);
      assert.strictEqual(response.data.logged, true);
      assertObject(response.data.heartbeat, 'Expected heartbeat decision');
    });

    test('POST /api/activity with pull_refresh returns heartbeat decision', async () => {
      const response = await requestJson('/api/activity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'pull_refresh' }),
      });
      assert.strictEqual(response.status, 200);
      assertObject(response.data, 'Expected activity payload');
      assertObject(response.data.heartbeat, 'Expected heartbeat decision');
      assert.strictEqual(typeof response.data.heartbeat.triggered, 'boolean');
    });
  });

  describe('Skills API', () => {
    test('GET /api/skills returns { items, total, active, registry, feedSources }', async () => {
      const response = await requestJson('/api/skills');
      assert.strictEqual(response.status, 200);
      assertObject(response.data, 'Expected skills payload');
      assert.ok(Array.isArray(response.data.items));
      assert.strictEqual(typeof response.data.total, 'number');
      assert.strictEqual(typeof response.data.active, 'number');
      assert.ok(Array.isArray(response.data.registry));
      assert.ok(Array.isArray(response.data.feedSources));
      assert.ok(response.data.registry.every((entry) => (
        entry
        && typeof entry === 'object'
        && 'installed' in entry
        && typeof (entry as { installed: unknown }).installed === 'boolean'
      )));
    });

    test('GET /api/skills exposes installed feed source metadata', async () => {
      const response = await requestJson('/api/skills');
      assert.strictEqual(response.status, 200);
      assertObject(response.data, 'Expected skills payload');
      assert.ok(Array.isArray(response.data.feedSources));

      const values = response.data.feedSources.map((entry) => (
        entry && typeof entry === 'object' && 'value' in entry ? (entry as { value: string }).value : null
      ));

      assert.ok(values.includes('twitter'));
      assert.ok(values.includes('youtube'));
      assert.ok(values.includes('hackernews'));
      assert.ok(values.includes('substack'));
    });

    test('GET /api/skills returns valid skills and feed sources when one installed skill is malformed', async () => {
      const skillDir = path.join(process.cwd(), '.claude', 'skills', 'api-malformed-source-filter-test');
      await fs.promises.mkdir(skillDir, { recursive: true });
      await fs.promises.writeFile(path.join(skillDir, 'SKILL.md'), '# Missing frontmatter\n', 'utf8');

      try {
        const response = await requestJson('/api/skills');
        assert.strictEqual(response.status, 200);
        assertObject(response.data, 'Expected skills payload');
        assert.ok(Array.isArray(response.data.items));
        assert.ok(Array.isArray(response.data.feedSources));
        assert.ok(Array.isArray(response.data.skippedSkills));

        const skippedSlugs = response.data.skippedSkills.map((entry) => (
          entry && typeof entry === 'object' && 'slug' in entry ? (entry as { slug: string }).slug : null
        ));
        const sourceValues = response.data.feedSources.map((entry) => (
          entry && typeof entry === 'object' && 'value' in entry ? (entry as { value: string }).value : null
        ));

        assert.ok(skippedSlugs.includes('api-malformed-source-filter-test'));
        assert.ok(sourceValues.includes('substack'));
        assert.ok(sourceValues.includes('youtube'));
        assert.ok(sourceValues.includes('hackernews'));
      } finally {
        await fs.promises.rm(skillDir, { recursive: true, force: true });
      }
    });

    test('GET /api/skills lists installed skills', async () => {
      const response = await requestJson('/api/skills');
      assert.strictEqual(response.status, 200);
      assertObject(response.data, 'Expected skills payload');
      assert.ok(Array.isArray(response.data.items));
      assert.ok(response.data.items.length >= 1);
      assert.strictEqual(response.data.total, response.data.items.length);
      const names = response.data.items.map((item) => (
        item && typeof item === 'object' && 'name' in item ? (item as { name: string }).name : null
      ));
      assert.ok(names.includes('setup-wizard'));
      assert.ok(names.includes('review-landed-merge'));
      assert.ok(Array.isArray(response.data.registry));
      assert.strictEqual(response.data.registry.length, 10);
    });
  });

  describe('Heartbeat Internal API', () => {
    test('POST /api/internal/heartbeat/check returns trigger decision', async () => {
      const response = await requestJson('/api/internal/heartbeat/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ triggeredBy: 'api-test' }),
      });
      assert.strictEqual(response.status, 200);
      assertObject(response.data, 'Expected heartbeat check payload');
      assert.strictEqual(typeof response.data.triggered, 'boolean');
      assert.strictEqual(typeof response.data.triggerReason, 'string');
    });

    test('POST /api/internal/heartbeat/complete returns result', async () => {
      const response = await requestJson('/api/internal/heartbeat/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: 'test-req' }),
      });
      assert.strictEqual(response.status, 200);
      assertObject(response.data, 'Expected heartbeat completion payload');
      assert.strictEqual(response.data.ok, true);
      assert.strictEqual(typeof response.data.completed, 'boolean');
      assert.strictEqual(response.data.requestId, 'test-req');
    });
  });

  describe('Reflection Internal API', () => {
    test('GET /api/internal/reflection/rejection-scorecard returns valid JSON when the candidates file is missing', async () => {
      const candidatesPath = getDataPath('curation-candidates.jsonl');
      const restore = await preserveFile(candidatesPath);
      await fs.promises.rm(candidatesPath, { force: true });

      try {
        const response = await requestJson('/api/internal/reflection/rejection-scorecard?hours=24');
        assert.strictEqual(response.status, 200);
        assertObject(response.data, 'Expected rejection scorecard payload');
        assert.strictEqual(response.data.cycleCount, 0);
        assert.strictEqual(response.data.totalRejected, 0);
        assert.deepStrictEqual(response.data.topRejectedAuthors, []);
        assert.deepStrictEqual(response.data.rejectionReasonCategories, {});
        assert.deepStrictEqual(response.data.almostRelevant, []);
        assert.strictEqual(response.data.hoursQueried, 24);
      } finally {
        await restore();
      }
    });

    test('GET /api/internal/reflection/upstream-health returns structured shared-browser evidence', async () => {
      const response = await requestJson('/api/internal/reflection/upstream-health?hours=24');
      assert.strictEqual(response.status, 200);
      assertObject(response.data, 'Expected upstream health payload');
      assert.strictEqual(response.data.hoursQueried, 24);
      assert.strictEqual(typeof response.data.cdpUrl, 'string');
      assert.ok(Array.isArray(response.data.expectedConsumers));
      assert.ok(Array.isArray(response.data.dependencies));
      assert.ok(Array.isArray(response.data.sourceDiagnoses));
      assert.ok(Array.isArray(response.data.explicitFailures));
      assert.ok(Array.isArray(response.data.maskedRuns));
      assert.ok(Array.isArray(response.data.affectedSources));
      assert.ok(response.data.primaryIssue === 'none' || response.data.primaryIssue === 'shared_browser_outage');
      assert.ok(
        response.data.primaryFailureKind === 'none'
        || response.data.primaryFailureKind === 'provider_hung'
        || response.data.primaryFailureKind === 'auth'
        || response.data.primaryFailureKind === 'rate_limited'
        || response.data.primaryFailureKind === 'source_regression',
      );
      assertObject(response.data.incident, 'Expected incident routing payload');
    });

  });

  describe('Interactions API', () => {
    test('GET /api/interactions?ids=nonexistent returns empty states', async () => {
      const response = await requestJson('/api/interactions?ids=nonexistent');
      assert.strictEqual(response.status, 200);
      assertObject(response.data, 'Expected interactions payload');
      assertObject(response.data.states, 'Expected states object');

      const likedEntries = Object.values(response.data.states).map((state) => {
        if (!state || typeof state !== 'object') return false;
        return (state as { liked?: unknown }).liked === true;
      });
      assert.ok(likedEntries.every((liked) => liked === false));
    });

    test('POST /api/interactions with { feedItemId, action: "like" } returns success', async () => {
      const feedItemId = await getInteractionFeedItemId();
      const response = await requestJson('/api/interactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedItemId, action: 'like' }),
      });
      assert.strictEqual(response.status, 200);
      assertObject(response.data, 'Expected interaction payload');
      assert.strictEqual(response.data.ok, true);
      assert.strictEqual(response.data.liked, true);

      await requestJson('/api/interactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedItemId, action: 'unlike' }),
      });
    });

    test('tweet thumbsup only triggers one persisted like increment across unlike/re-like', async () => {
      const feedItemId = createTestFeedItem({
        type: 'tweet',
        source: 'twitter',
        sourceId: '2030455675357143260',
        metricsLikes: 3,
      });

      try {
        const likeResponse = await requestJson('/api/interactions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ feedItemId, action: 'thumbsup' }),
        });
        assert.strictEqual(likeResponse.status, 200);
        assertObject(likeResponse.data, 'Expected thumbsup response payload');
        assert.strictEqual(likeResponse.data.shouldPassthroughLike, true);

        const passthroughResponse = await requestJson(`/api/feed/${encodeURIComponent(feedItemId)}/like`, {
          method: 'POST',
        });
        assert.strictEqual(passthroughResponse.status, 200);
        assertObject(passthroughResponse.data, 'Expected passthrough response payload');
        assert.strictEqual(passthroughResponse.data.ok, true);

        const detailAfterFirstLike = await requestJson(`/api/feed/${encodeURIComponent(feedItemId)}`);
        assert.strictEqual(detailAfterFirstLike.status, 200);
        assertObject(detailAfterFirstLike.data, 'Expected feed detail payload');
        assertObject(detailAfterFirstLike.data.item, 'Expected feed item payload');
        assert.strictEqual(detailAfterFirstLike.data.item.metrics.likes, 4);

        const undoResponse = await requestJson('/api/interactions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ feedItemId, action: 'undo_thumbsup' }),
        });
        assert.strictEqual(undoResponse.status, 200);

        const relikeResponse = await requestJson('/api/interactions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ feedItemId, action: 'thumbsup' }),
        });
        assert.strictEqual(relikeResponse.status, 200);
        assertObject(relikeResponse.data, 'Expected re-like response payload');
        assert.strictEqual(relikeResponse.data.shouldPassthroughLike, false);

        const detailAfterRelike = await requestJson(`/api/feed/${encodeURIComponent(feedItemId)}`);
        assert.strictEqual(detailAfterRelike.status, 200);
        assertObject(detailAfterRelike.data, 'Expected feed detail payload');
        assertObject(detailAfterRelike.data.item, 'Expected feed item payload');
        assert.strictEqual(detailAfterRelike.data.item.metrics.likes, 4);
      } finally {
        removeTestFeedItem(feedItemId);
      }
    });

    test('POST /api/feed/[id]/like short-circuits for non-tweets', async () => {
      const feedItemId = createTestFeedItem({
        type: 'article',
        source: 'rss',
        sourceId: `article-${Date.now()}`,
        metricsLikes: 7,
      });

      try {
        const response = await requestJson(`/api/feed/${encodeURIComponent(feedItemId)}/like`, {
          method: 'POST',
        });
        assert.strictEqual(response.status, 200);
        assertObject(response.data, 'Expected non-tweet like payload');
        assert.strictEqual(response.data.ok, true);
        assert.strictEqual(response.data.passthrough, false);
        assert.strictEqual(response.data.reason, 'not-a-tweet');

        const detailResponse = await requestJson(`/api/feed/${encodeURIComponent(feedItemId)}`);
        assert.strictEqual(detailResponse.status, 200);
        assertObject(detailResponse.data, 'Expected feed detail payload');
        assertObject(detailResponse.data.item, 'Expected feed item payload');
        assert.strictEqual(detailResponse.data.item.metrics.likes, 7);
      } finally {
        removeTestFeedItem(feedItemId);
      }
    });
  });

  describe('Preferences API', () => {
    test('GET /api/preferences returns items + stats', async () => {
      const response = await requestJson('/api/preferences');
      assert.strictEqual(response.status, 200);
      assertObject(response.data, 'Expected preferences payload');
      assert.ok(Array.isArray(response.data.items));
      assertObject(response.data.stats, 'Expected preference stats object');
      assert.strictEqual(typeof response.data.stats.total, 'number');
    });

    test('GET /api/preferences?type=liked returns filtered list', async () => {
      const response = await requestJson('/api/preferences?type=liked');
      assert.strictEqual(response.status, 200);
      assertObject(response.data, 'Expected preferences payload');
      assert.ok(Array.isArray(response.data.items));
    });

    test('GET /api/preferences supports pagination metadata', async () => {
      const response = await requestJson('/api/preferences?type=all&offset=0&limit=5');
      assert.strictEqual(response.status, 200);
      assertObject(response.data, 'Expected preferences payload');
      assert.ok(Array.isArray(response.data.items));
      assertObject(response.data.pagination, 'Expected pagination object');
      assert.strictEqual(typeof response.data.pagination.total, 'number');
      assert.strictEqual(typeof response.data.pagination.offset, 'number');
      assert.strictEqual(typeof response.data.pagination.limit, 'number');
      assert.strictEqual(typeof response.data.pagination.hasMore, 'boolean');
      assert.strictEqual(typeof response.data.pagination.nextOffset, 'number');
    });

    test('DELETE /api/preferences/[id] removes a preference row', async () => {
      let listResponse = await requestJson('/api/preferences?offset=0&limit=1&type=all');
      assert.strictEqual(listResponse.status, 200);
      assertObject(listResponse.data, 'Expected preferences payload');
      assert.ok(Array.isArray(listResponse.data.items));

      if (listResponse.data.items.length === 0) {
        const feedItemId = await getInteractionFeedItemId();
        const createResponse = await requestJson('/api/interactions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ feedItemId, action: 'thumbsup' }),
        });
        assert.strictEqual(createResponse.status, 200);
        listResponse = await requestJson('/api/preferences?offset=0&limit=1&type=liked');
        assert.strictEqual(listResponse.status, 200);
        assertObject(listResponse.data, 'Expected preferences payload');
        assert.ok(Array.isArray(listResponse.data.items));
      }

      assert.ok(listResponse.data.items.length > 0, 'Expected at least one preference to delete');
      const target = listResponse.data.items[0];
      assertObject(target, 'Expected preference item object');
      assert.strictEqual(typeof target.id, 'string');

      const deleteResponse = await requestJson(`/api/preferences/${encodeURIComponent(target.id)}`, {
        method: 'DELETE',
      });
      assert.strictEqual(deleteResponse.status, 200);
      assertObject(deleteResponse.data, 'Expected delete response payload');
      assert.strictEqual(deleteResponse.data.ok, true);

      const verifyResponse = await requestJson('/api/preferences?offset=0&limit=25&type=all');
      assert.strictEqual(verifyResponse.status, 200);
      assertObject(verifyResponse.data, 'Expected preferences payload');
      assert.ok(Array.isArray(verifyResponse.data.items));
      const stillPresent = verifyResponse.data.items.some((item) => {
        if (!item || typeof item !== 'object') return false;
        return (item as { id?: unknown }).id === target.id;
      });
      assert.strictEqual(stillPresent, false);
    });

    test('PATCH /api/preferences/[id] updates reason text', async () => {
      let listResponse = await requestJson('/api/preferences?offset=0&limit=25&type=all');
      assert.strictEqual(listResponse.status, 200);
      assertObject(listResponse.data, 'Expected preferences payload');
      assert.ok(Array.isArray(listResponse.data.items));

      if (listResponse.data.items.length === 0) {
        const feedItemId = await getInteractionFeedItemId();
        const createResponse = await requestJson('/api/interactions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ feedItemId, action: 'thumbsup' }),
        });
        assert.strictEqual(createResponse.status, 200);
        listResponse = await requestJson('/api/preferences?offset=0&limit=25&type=all');
        assert.strictEqual(listResponse.status, 200);
        assertObject(listResponse.data, 'Expected preferences payload');
        assert.ok(Array.isArray(listResponse.data.items));
      }

      assert.ok(listResponse.data.items.length > 0, 'Expected at least one preference to patch');
      const target = listResponse.data.items[0];
      assertObject(target, 'Expected preference item object');
      assert.strictEqual(typeof target.id, 'string');
      const originalReason = typeof target.reason === 'string' ? target.reason : '';
      const patchedReason = `updated-reason-${Date.now()}`;

      try {
        const patchResponse = await requestJson(`/api/preferences/${encodeURIComponent(target.id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: patchedReason }),
        });
        assert.strictEqual(patchResponse.status, 200);
        assertObject(patchResponse.data, 'Expected patch response payload');
        assert.strictEqual(patchResponse.data.ok, true);
        assertObject(patchResponse.data.item, 'Expected updated preference');
        assert.strictEqual(patchResponse.data.item.reason, patchedReason);

        const verifyResponse = await requestJson('/api/preferences?offset=0&limit=100&type=all');
        assert.strictEqual(verifyResponse.status, 200);
        assertObject(verifyResponse.data, 'Expected preferences payload');
        assert.ok(Array.isArray(verifyResponse.data.items));
        const updatedEntry = verifyResponse.data.items.find((item) => {
          if (!item || typeof item !== 'object') return false;
          return (item as { id?: unknown }).id === target.id;
        }) as { reason?: unknown } | undefined;
        assert.ok(updatedEntry, 'Expected patched preference in list');
        assert.strictEqual(updatedEntry?.reason, patchedReason);
      } finally {
        await requestJson(`/api/preferences/${encodeURIComponent(target.id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: originalReason }),
        });
      }
    });

    test('POST /api/preferences returns recent preference window', async () => {
      const response = await requestJson('/api/preferences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hours: 48, limit: 100, onlyWithReason: false }),
      });

      assert.strictEqual(response.status, 200);
      assertObject(response.data, 'Expected preferences payload');
      assert.ok(Array.isArray(response.data.items));
      assert.strictEqual(typeof response.data.count, 'number');
      assert.strictEqual(typeof response.data.reasonedCount, 'number');
      assertObject(response.data.filters, 'Expected filters payload');
      assert.strictEqual(typeof response.data.filters.since, 'string');
    });

    test('POST /api/preferences/match returns relevance payload', async () => {
      const response = await requestJson('/api/preferences/match', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Latest transformer model updates in machine learning' }),
      });

      assert.strictEqual(response.status, 200);
      assertObject(response.data, 'Expected preference match payload');
      assert.strictEqual(typeof response.data.relevanceScore, 'number');
      assert.strictEqual(typeof response.data.matchedLikes, 'number');
      assert.strictEqual(typeof response.data.matchedDislikes, 'number');
      assert.strictEqual(typeof response.data.verdict, 'string');
      assert.ok(Array.isArray(response.data.topMatches));
    });
  });

  describe('Orchestrator Internal API', () => {
    test('POST /api/orchestrator/enqueue returns { ok, requestId, queueDepth }', async () => {
      const response = await requestJson('/api/orchestrator/enqueue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `API integration test enqueue ${Date.now()}`,
          source: 'api-test',
          priority: 'user_ping',
        }),
      });
      assert.strictEqual(response.status, 202);
      assertObject(response.data, 'Expected enqueue payload');
      assert.strictEqual(response.data.ok, true);
      assert.strictEqual(typeof response.data.requestId, 'string');
      assert.strictEqual(typeof response.data.queueDepth, 'number');
    });

    test('POST /api/internal/orchestrator/enqueue preserves chat_research source', async () => {
      const requestId = `api-chat-research-${randomUUID()}`;
      const response = await requestJson('/api/internal/orchestrator/enqueue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: '[unit] API internal enqueue chat research source',
          source: 'chat_research',
          priority: 'user_ping',
          requestId,
        }),
      });

      assert.strictEqual(response.status, 202);
      assertObject(response.data, 'Expected internal enqueue payload');
      assert.strictEqual(response.data.ok, true);
      assert.strictEqual(response.data.requestId, requestId);

      const task = await waitForOrchestratorTask(requestId);
      assert.strictEqual(task.source, 'chat_research');
      assert.strictEqual(task.priority, 'user_ping');
    });

    test('GET /api/orchestrator/status returns queue state', async () => {
      const response = await requestJson('/api/orchestrator/status');
      assert.strictEqual(response.status, 200);
      assertObject(response.data, 'Expected orchestrator status payload');
      assert.strictEqual(typeof response.data.queueDepth, 'number');
      assert.strictEqual(typeof response.data.isProcessing, 'boolean');
      assert.ok(Array.isArray(response.data.queued));
      assert.ok(Array.isArray(response.data.history));
    });
  });

  describe('Curation Submit Internal API', () => {
    test('POST /api/internal/curate/submit queues one batch enrichment task for tweets and Hacker News items only', async () => {
      const db = getDb();
      const tweetId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
      const articleSourceId = `https://example.com/?enrichment=${randomUUID()}`;
      const hackerNewsSourceId = `hn-submit-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
      const originSessionId = createValidationOriginSessionId('api-submit-enrich');

      try {
        const response = await requestJson('/api/internal/curate/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            originSessionId,
            items: [
              {
                id: `ma-submit-enrich-${randomUUID()}`,
                type: 'tweet',
                source: 'twitter',
                sourceId: tweetId,
                parentId: null,
                relationship: 'parent',
                title: null,
                text: 'Submit route should enrich this tweet before websocket notify.',
                url: `https://x.com/mock_user/status/${tweetId}`,
                excerpt: null,
                authorUsername: 'mock_user',
                authorDisplayName: 'Mock User',
                authorAvatarUrl: null,
                reason: 'Exercise tweet enrichment path',
                tags: ['test'],
                mediaUrls: [],
                publishedAt: '2026-03-08T11:45:00.000Z',
                metadata: {},
              },
              {
                id: `ma-submit-enrich-article-${randomUUID()}`,
                type: 'article',
                source: 'web',
                sourceId: articleSourceId,
                parentId: null,
                relationship: null,
                title: 'Focused enrichment article',
                text: 'A top-level article should queue its own enrichment task.',
                excerpt: 'Queued article enrichment coverage',
                url: articleSourceId,
                authorUsername: 'reporter',
                authorDisplayName: 'Reporter',
                authorAvatarUrl: null,
                reason: 'Exercise per-item article enrichment queueing',
                tags: ['test'],
                mediaUrls: [],
                publishedAt: '2026-03-08T11:46:00.000Z',
                metadata: {},
              },
              {
                id: `ma-submit-enrich-hn-${randomUUID()}`,
                type: 'article',
                source: 'hackernews',
                sourceId: hackerNewsSourceId,
                parentId: null,
                relationship: null,
                title: 'Focused enrichment HN article',
                text: 'A Hacker News item should be included in the batch enrichment task.',
                excerpt: 'Queued Hacker News enrichment coverage',
                url: `https://example.com/?hn-story=${randomUUID()}`,
                authorUsername: 'hn_user',
                authorDisplayName: 'HN User',
                authorAvatarUrl: null,
                reason: 'Exercise batch Hacker News enrichment queueing',
                tags: ['test'],
                mediaUrls: [],
                publishedAt: '2026-03-08T11:47:00.000Z',
                metadata: {
                  hnUrl: 'https://news.ycombinator.com/item?id=12345',
                },
              },
            ],
          }),
        });

        assert.strictEqual(response.status, 200);
        assertObject(response.data, 'Expected curation submit payload');
        assert.strictEqual(response.data.accepted, 3);
        assert.strictEqual(response.data.duplicates, 0);
        assert.ok(Array.isArray(response.data.acceptedIds));

        const insertedItems = db.prepare(`
          SELECT
            id,
            type,
            source_id AS sourceId,
            url,
            author_avatar_url AS authorAvatarUrl,
            media_urls AS mediaUrls,
            metrics_likes AS likes,
            metrics_reposts AS reposts,
            metrics_replies AS replies,
            source,
            metadata
          FROM feed
          WHERE source_id IN (?, ?, ?)
          ORDER BY source_id ASC
        `).all(tweetId, articleSourceId, hackerNewsSourceId) as Array<{
          id: string;
          type: string;
          sourceId: string;
          url: string | null;
          authorAvatarUrl: string | null;
          mediaUrls: string | null;
          likes: number | null;
          reposts: number | null;
          replies: number | null;
          source: string | null;
          metadata: string | null;
        }>;

        assert.strictEqual(insertedItems.length, 3);
        const eligibleItemIds: string[] = [];
        const metadataByItemId = new Map<string, {
          fullEnrichmentRequestId?: unknown;
          batchEnrichment?: {
            requestId?: unknown;
            status?: unknown;
            itemCount?: unknown;
            retryEligible?: unknown;
          };
        }>();
        for (const insertedItem of insertedItems) {
          const metadata = JSON.parse(insertedItem.metadata ?? '{}') as {
            fullEnrichmentRequestId?: unknown;
            batchEnrichment?: {
              requestId?: unknown;
              status?: unknown;
              itemCount?: unknown;
              retryEligible?: unknown;
            };
          };
          metadataByItemId.set(insertedItem.id, metadata);

          if (insertedItem.type === 'tweet') {
            assert.strictEqual(insertedItem.url, `https://x.com/mock_user/status/${insertedItem.sourceId}`);
            eligibleItemIds.push(insertedItem.id);
          } else if (insertedItem.source === 'hackernews') {
            eligibleItemIds.push(insertedItem.id);
          } else {
            assert.strictEqual(insertedItem.url, articleSourceId);
          }

          assert.strictEqual(insertedItem.authorAvatarUrl, null);
          assert.deepStrictEqual(JSON.parse(insertedItem.mediaUrls ?? '[]'), []);
          assert.deepStrictEqual({
            likes: insertedItem.likes,
            reposts: insertedItem.reposts,
            replies: insertedItem.replies,
          }, {
            likes: 0,
            reposts: 0,
            replies: 0,
          });
          assert.strictEqual(metadata.fullEnrichmentRequestId, undefined);
        }

        const firstEligibleItemId = insertedItems.find((item) => item.type === 'tweet')?.id;
        assert.ok(firstEligibleItemId);
        const expectedRequestId = `curation-submit-enrichment-batch-${firstEligibleItemId}-2`;
        for (const eligibleItemId of eligibleItemIds) {
          const metadata = metadataByItemId.get(eligibleItemId);
          assertObject(metadata?.batchEnrichment, 'Expected automatic batch enrichment metadata');
          assert.strictEqual(metadata?.batchEnrichment?.requestId, expectedRequestId);
          assert.strictEqual(metadata?.batchEnrichment?.status, 'queued');
          assert.strictEqual(metadata?.batchEnrichment?.itemCount, 2);
          assert.strictEqual(metadata?.batchEnrichment?.retryEligible, true);
        }
        const task = await waitForOrchestratorTask(expectedRequestId);
        assert.strictEqual(task.id, expectedRequestId);
        assert.strictEqual(task.source, 'curation_submit_feed_enrichment');
        assert.strictEqual(task.priority, 'post_enrichment');
        assertObject(task.metadata, 'Expected queued task metadata');
        assert.strictEqual(task.metadata.enrichmentMode, 'batch');
        assert.strictEqual(task.metadata.itemCount, 2);
        assert.deepStrictEqual([...(task.metadata.postIds as string[])].sort(), eligibleItemIds.sort());
        assert.strictEqual(task.metadata.trigger, 'curation_submit_batch');
        assert.strictEqual(typeof task.messagePreview, 'string');
        assert.match(task.messagePreview as string, /batch post enrichment sub-agent/i);
      } finally {
        await cleanupValidationFixtures({
          sourceIds: [tweetId, articleSourceId, hackerNewsSourceId],
          originSessionIds: [originSessionId],
        }, BASE_URL);
      }
    });

    test('POST /api/internal/curate/submit rejects YouTube items that drop thumbnail and raw publish metadata', async () => {
      const videoId = `video-submit-bad-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
      const originSessionId = createValidationOriginSessionId('api-submit-youtube-missing');

      const response = await requestJson('/api/internal/curate/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          originSessionId,
          items: [
            {
              id: `ma-submit-youtube-missing-${randomUUID()}`,
              type: 'article',
              source: 'youtube',
              sourceId: videoId,
              title: 'Broken YouTube submit fixture',
              text: 'Broken YouTube submit fixture',
              url: `https://www.youtube.com/watch?v=${videoId}`,
              reason: 'Exercise YouTube canonical validation',
              tags: ['test'],
              mediaUrls: [],
              publishedAt: '2026-03-29T00:00:00.000Z',
              metadata: {},
            },
          ],
        }),
      });

      assert.strictEqual(response.status, 200);
      assertObject(response.data, 'Expected curation submit payload');
      assert.strictEqual(response.data.accepted, 0);
      assert.strictEqual(response.data.duplicates, 0);
      assert.ok(Array.isArray(response.data.errors));
      assert.match(String(response.data.errors[0]?.error), /thumbnailUrl|publishDate|publishDateText/i);
    });

    test('POST /api/internal/curate/submit accepts notification items and stores notification metadata', async () => {
      const notificationId = `submit-notification-${randomUUID()}`;
      const originSessionId = createValidationOriginSessionId('api-submit-notification');
      try {
        const response = await requestJson('/api/internal/curate/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            originSessionId,
            items: [
              {
                id: `ma-submit-notification-${randomUUID()}`,
                type: 'notification',
                source: 'system',
                sourceId: notificationId,
                title: 'Notification title',
                text: 'Notification body',
                excerpt: 'Guidance',
                reason: 'Notification test',
                tags: ['system', 'notification'],
                mediaUrls: [],
                publishedAt: '2026-03-08T11:45:00.000Z',
                metadata: {
                  notificationId,
                  severity: 'warning',
                  dismissable: false,
                  autoResolveCondition: 'tweet-cache-auth-ok',
                  expiresAt: '2026-03-09T11:45:00.000Z',
                },
              },
            ],
          }),
        });

        assert.strictEqual(response.status, 200);
        assertObject(response.data, 'Expected curation submit payload');
        assert.strictEqual(response.data.accepted, 1);
        assert.strictEqual(response.data.duplicates, 0);

        const stored = getDb().prepare(`
          SELECT type, metadata
          FROM feed
          WHERE source_id = ?
        `).get(notificationId) as { type: string; metadata: string | null } | undefined;

        assert.ok(stored, 'Expected stored notification feed item');
        assert.strictEqual(stored?.type, 'notification');
        assert.ok(stored?.metadata);
        const metadata = JSON.parse(stored?.metadata ?? '{}') as Record<string, unknown>;
        assert.strictEqual(metadata.notificationId, notificationId);
        assert.strictEqual(metadata.severity, 'warning');
        assert.strictEqual(metadata.dismissable, false);
        assert.strictEqual(metadata.autoResolveCondition, 'tweet-cache-auth-ok');
        assert.strictEqual(metadata.expiresAt, '2026-03-09T11:45:00.000Z');
      } finally {
        await cleanupValidationFixtures({
          sourceIds: [notificationId],
          originSessionIds: [originSessionId],
        }, BASE_URL);
      }
    });

    test('POST /api/internal/curate/submit rejects config-change suggestions with invalid prompt integrity', async () => {
      const response = await requestJson('/api/internal/curate/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [
            {
              id: `ma-invalid-config-suggestion-${randomUUID()}`,
              type: 'suggestion',
              source: 'claude',
              sourceId: `invalid-config-suggestion-${randomUUID()}`,
              title: 'Broken config suggestion',
              text: 'This should be rejected.',
              reason: 'Validation test',
              publishedAt: '2026-03-08T11:45:00.000Z',
              metadata: {
                suggestionType: 'other',
                configField: 'Suggested Updates',
                configFile: 'data/curation-prompt.md',
                proposedValue: [
                  '--- data/curation-prompt.md',
                  '+++ data/curation-prompt.md',
                  '@@ -1,1 +1,2 @@',
                  '+Add mechanism-level analysis.',
                ].join('\n'),
              },
            },
          ],
        }),
      });

      assert.strictEqual(response.status, 200);
      assertObject(response.data, 'Expected curation submit payload');
      assert.strictEqual(response.data.accepted, 0);
      assert.strictEqual(response.data.duplicates, 0);
      assert.ok(Array.isArray(response.data.errors));
      assert.match(String(response.data.errors[0]?.error), /Invalid section|raw unified diff markers/);
    });

    test('POST /api/internal/curate/submit inserts accepted items, reports duplicates, and logs candidates', async () => {
      const db = getDb();
      const tweetId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
      const parentSourceId = `curate-parent-${randomUUID()}`;
      const childSourceId = `curate-child-${randomUUID()}`;
      const candidatesPath = getDataPath('curation-candidates.jsonl');
      const candidatesOffset = await getFileSize(candidatesPath);
      const originSessionId = createValidationOriginSessionId('api-submit-batch');

      try {
        const response = await requestJson('/api/internal/curate/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            originSessionId,
            items: [
              {
                id: `ma-submit-tweet-${randomUUID()}`,
                type: 'tweet',
                source: 'twitter',
                sourceId: `tweet-${tweetId}`,
                parentId: null,
                relationship: 'parent',
                title: null,
                text: 'Batch submit should insert this tweet once.',
                url: `https://x.com/cached_author/status/${tweetId}`,
                excerpt: 'tweet excerpt',
                authorUsername: 'cached_author',
                authorDisplayName: 'Cached Author',
                authorAvatarUrl: 'https://example.com/avatar.png',
                reason: 'High-signal cache hit',
                tags: ['ai', 'policy'],
                mediaUrls: [],
                publishedAt: '2026-03-08T11:45:00.000Z',
                metadata: {},
              },
              {
                id: `ma-submit-parent-${randomUUID()}`,
                type: 'article',
                source: 'publication-slug',
                sourceId: parentSourceId,
                parentId: null,
                relationship: 'parent',
                title: 'Parent article',
                text: 'A source synopsis for the parent item explains why this article anchors the related batch insert.',
                url: `https://example.com/?article=${parentSourceId}`,
                excerpt: 'parent excerpt',
                authorUsername: 'editor',
                authorDisplayName: 'Editor',
                authorAvatarUrl: null,
                reason: 'Anchor item for related analysis',
                tags: ['analysis'],
                mediaUrls: [],
                publishedAt: '2026-03-08T10:00:00.000Z',
                metadata: {},
              },
              {
                id: `ma-submit-child-${randomUUID()}`,
                type: 'analysis',
                source: 'claude',
                sourceId: childSourceId,
                parentId: parentSourceId,
                relationship: 'analysis',
                title: 'Analysis child',
                text: 'This analysis item should resolve its parent by sourceId within the batch.',
                url: null,
                excerpt: 'child excerpt',
                authorUsername: null,
                authorDisplayName: null,
                authorAvatarUrl: null,
                reason: 'Adds internal context',
                tags: ['analysis'],
                mediaUrls: [],
                publishedAt: '2026-03-08T10:05:00.000Z',
                metadata: {},
              },
              {
                id: `ma-submit-duplicate-${randomUUID()}`,
                type: 'tweet',
                source: 'twitter',
                sourceId: tweetId,
                parentId: null,
                relationship: 'parent',
                title: null,
                text: 'This second tweet should be reported as a duplicate.',
                url: `https://x.com/cached_author/status/${tweetId}`,
                excerpt: null,
                authorUsername: 'cached_author',
                authorDisplayName: 'Cached Author',
                authorAvatarUrl: null,
                reason: 'Duplicate',
                tags: [],
                mediaUrls: [],
                publishedAt: '2026-03-08T11:45:30.000Z',
                metadata: {},
              },
            ],
            candidates: [
              {
                cycleId: `curate-${tweetId}`,
                sourceId: 'candidate-1',
                authorUsername: '@skip1',
                text: 'Candidate text one',
                reason: 'Considered for novelty',
                rejectionReason: 'already covered',
                timestamp: '2026-03-08T11:46:00.000Z',
              },
              {
                cycleId: `curate-${tweetId}`,
                sourceId: 'candidate-2',
                authorUsername: '@skip2',
                text: 'Candidate text two',
                reason: 'Considered for variety',
                rejectionReason: 'low engagement',
                timestamp: '2026-03-08T11:47:00.000Z',
              },
            ],
            cycleSummary: {
              cycleId: `curate-${tweetId}`,
              considered: 4,
              selected: 3,
              rejected: 1,
              topRejectionReasons: ['already covered', 'low engagement'],
              metadata: {
                sourceRecoveryExperiment: {
                  attemptedSources: ['twitter'],
                  successfulSources: ['twitter'],
                  submittedSourceIds: [tweetId],
                },
              },
            },
          }),
        });

        assert.strictEqual(response.status, 200);
        assertObject(response.data, 'Expected curation submit payload');
        assert.strictEqual(response.data.accepted, 3);
        assert.strictEqual(response.data.duplicates, 1);
        assert.deepStrictEqual(response.data.errors, []);
        assert.ok(Array.isArray(response.data.acceptedIds));
        assert.strictEqual(response.data.acceptedIds.length, 3);
        assert.deepStrictEqual(response.data.duplicateSourceIds, [tweetId]);

        const tweetRow = db.prepare(`
          SELECT id, source_id AS sourceId
          FROM feed
          WHERE source_id = ?
        `).get(tweetId) as { id: string; sourceId: string } | undefined;
        assert.ok(tweetRow, 'Expected normalized tweet row to exist');
        assert.strictEqual(tweetRow?.sourceId, tweetId);

        const parentRow = db.prepare(`
          SELECT id
          FROM feed
          WHERE source_id = ?
        `).get(parentSourceId) as { id: string } | undefined;
        const childRow = db.prepare(`
          SELECT parent_id AS parentId
          FROM feed
          WHERE source_id = ?
        `).get(childSourceId) as { parentId: string | null } | undefined;
        assert.ok(parentRow, 'Expected parent row to exist');
        assert.ok(childRow, 'Expected child row to exist');
        assert.strictEqual(childRow?.parentId, parentRow?.id);

        const feedResponse = await requestJson<FeedListResponse>('/api/feed?limit=100');
        assert.strictEqual(feedResponse.status, 200);
        assert.ok(feedResponse.data.items.some((item) => item.sourceId === tweetId));
        assert.ok(feedResponse.data.items.some((item) => item.sourceId === parentSourceId));

        const candidateEntries = await readJsonlEntriesSince(candidatesPath, candidatesOffset);
        assert.strictEqual(candidateEntries.length, 3);
        assert.strictEqual(candidateEntries[0]?.sourceId, 'candidate-1');
        assert.strictEqual(candidateEntries[1]?.sourceId, 'candidate-2');
        assert.strictEqual(candidateEntries[2]?.type, 'cycle_summary');
        assert.strictEqual(candidateEntries[2]?.cycleId, `curate-${tweetId}`);
        assert.deepStrictEqual(candidateEntries[2]?.metadata, {
          sourceRecoveryExperiment: {
            attemptedSources: ['twitter'],
            successfulSources: ['twitter'],
            submittedSourceIds: [tweetId],
          },
        });
      } finally {
        await cleanupValidationFixtures({
          sourceIds: [tweetId, parentSourceId, childSourceId],
          originSessionIds: [originSessionId],
        }, BASE_URL);
      }
    });

    test('POST /api/internal/curate/submit preserves agent metadata across item types while keeping normalized fields', async () => {
      const db = getDb();
      const threadId = `thread-submit-${randomUUID()}`;
      const cycleId = `curate-${randomUUID()}`;
      const tweetId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
      const articleSourceId = `https://example.com/?article=${randomUUID()}`;
      const videoId = `video-${randomUUID().replace(/-/g, '').slice(0, 10)}`;
      const analysisSourceId = `analysis-${randomUUID()}`;
      const suggestionSourceId = `suggestion-${randomUUID()}`;
      const requestOriginSessionId = createValidationOriginSessionId('api-submit-meta-request');
      const itemOriginSessionId = createValidationOriginSessionId('api-submit-meta-item');

      try {
        const response = await requestJson('/api/internal/curate/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            originSessionId: requestOriginSessionId,
            items: [
              {
                id: `ma-submit-thread-tweet-${randomUUID()}`,
                type: 'tweet',
                source: 'twitter',
                sourceId: `tweet-${tweetId}`,
                text: 'Threaded tweet with extra agent metadata.',
                url: `https://x.com/thread_author/status/${tweetId}`,
                authorUsername: 'thread_author',
                authorDisplayName: 'Thread Author',
                reason: 'Tweet metadata merge coverage',
                publishedAt: '2026-03-08T11:45:00.000Z',
                originSessionId: itemOriginSessionId,
                metadata: {
                  cycleId,
                  originSessionId: itemOriginSessionId,
                  originKind: 'curator_chat',
                  thread: {
                    threadId,
                    threadTitle: 'AI coding reliability',
                    threadRationale: 'Same ongoing conversation',
                    continuing: true,
                    prominence: {
                      level: 'lead',
                      source: 'homepage',
                      evidence: 'Largest WSJ homepage headline.',
                      homepageUrl: 'https://www.wsj.com/',
                    },
                  },
                  riskyTake: { reason: 'Adjacent but grounded' },
                  currentInterestReason: 'Recent currentUser posts center on AI coding reliability',
                  conversationId: 'conversation-123',
                  media: [{ type: 'image', url: 'https://example.com/thread-image.jpg' }],
                  mediaTypes: ['video'],
                },
              },
              {
                id: `ma-submit-thread-article-${randomUUID()}`,
                type: 'article',
                source: 'substack',
                sourceId: articleSourceId,
                title: 'Threaded article',
                text: 'A publisher summary describes the threaded article while preserving risky-take metadata.',
                url: articleSourceId,
                reason: 'Article metadata merge coverage',
                publishedAt: '2026-03-08T10:45:00.000Z',
                metadata: {
                  cycleId,
                  originKind: 'curator_chat',
                  thread: {
                    threadId,
                    threadTitle: 'AI coding reliability',
                    threadRationale: 'Expands the same debate',
                  },
                  riskyTake: { reason: 'Contrarian but relevant angle' },
                },
              },
              {
                id: `ma-submit-thread-youtube-${randomUUID()}`,
                type: 'article',
                source: 'youtube',
                sourceId: videoId,
                title: 'Threaded video',
                text: 'Threaded YouTube item with current-interest metadata.',
                url: `https://www.youtube.com/watch?v=${videoId}`,
                reason: 'YouTube metadata merge coverage',
                publishedAt: '2026-03-08T09:45:00.000Z',
                metadata: {
                  cycleId,
                  thread: {
                    threadId,
                    threadTitle: 'AI coding reliability',
                  },
                  currentInterestReason: 'Recent currentUser replies mention verification and Mythos',
                  thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
                  publishDate: '2026-03-07T09:00:00.000Z',
                  channelName: 'Thread Channel',
                },
              },
              {
                id: `ma-submit-thread-analysis-${randomUUID()}`,
                type: 'analysis',
                source: 'claude',
                sourceId: analysisSourceId,
                parentId: articleSourceId,
                relationship: 'analysis',
                title: 'Thread synthesis',
                text: 'A short synthesis.\n\n## Sources\n- one\n- two',
                reason: 'Analysis metadata merge coverage',
                publishedAt: '2026-03-08T12:00:00.000Z',
                metadata: {
                  cycleId,
                  thread: {
                    threadId,
                    threadTitle: 'AI coding reliability',
                  },
                  currentInterestReason: 'Synthesis ties together the active lane',
                },
              },
              {
                id: `ma-submit-thread-suggestion-${randomUUID()}`,
                type: 'suggestion',
                source: 'claude',
                sourceId: suggestionSourceId,
                title: 'Suggestion keeps known metadata',
                text: 'Preserve suggestion metadata alongside agent extensions.',
                reason: 'Suggestion metadata merge coverage',
                publishedAt: '2026-03-08T12:15:00.000Z',
                metadata: {
                  cycleId,
                  suggestionType: 'code_fix',
                  proposedValue: 'Keep suggestion metadata intact while merging unknown keys.',
                  thread: {
                    threadId,
                    threadTitle: 'AI coding reliability',
                  },
                },
              },
            ],
          }),
        });

        assert.strictEqual(response.status, 200);
        assertObject(response.data, 'Expected curation submit payload');
        assert.strictEqual(response.data.accepted, 5);
        assert.strictEqual(response.data.duplicates, 0);

        const rows = db.prepare(`
          SELECT source_id AS sourceId, origin_session_id AS originSessionId, metadata
          FROM feed
          WHERE source_id IN (?, ?, ?, ?, ?)
          ORDER BY source_id ASC
        `).all(
          tweetId,
          articleSourceId,
          videoId,
          analysisSourceId,
          suggestionSourceId,
        ) as Array<{ sourceId: string; originSessionId: string | null; metadata: string | null }>;

        assert.strictEqual(rows.length, 5);
        const rowBySourceId = new Map(rows.map((row) => [
          row.sourceId,
          {
            ...row,
            metadata: JSON.parse(row.metadata ?? '{}') as Record<string, unknown>,
          },
        ]));

        const tweetRow = rowBySourceId.get(tweetId);
        assert.ok(tweetRow, 'Expected stored tweet row');
        assert.strictEqual(tweetRow?.originSessionId, itemOriginSessionId);
        assert.strictEqual(tweetRow?.metadata.originSessionId, itemOriginSessionId);
        assert.strictEqual(tweetRow?.metadata.originKind, 'curator_chat');
        assert.deepStrictEqual(tweetRow?.metadata.thread, {
          threadId,
          threadTitle: 'AI coding reliability',
          threadRationale: 'Same ongoing conversation',
          continuing: true,
          prominence: {
            level: 'lead',
            source: 'homepage',
            evidence: 'Largest WSJ homepage headline.',
            homepageUrl: 'https://www.wsj.com/',
          },
        });
        assert.deepStrictEqual(tweetRow?.metadata.riskyTake, { reason: 'Adjacent but grounded' });
        assert.strictEqual(tweetRow?.metadata.currentInterestReason, 'Recent currentUser posts center on AI coding reliability');
        assert.strictEqual(tweetRow?.metadata.cycleId, cycleId);
        assert.strictEqual(tweetRow?.metadata.conversationId, 'conversation-123');
        assert.deepStrictEqual(tweetRow?.metadata.mediaTypes, ['video']);

        const articleRow = rowBySourceId.get(articleSourceId);
        assert.ok(articleRow, 'Expected stored article row');
        assert.strictEqual(articleRow?.originSessionId, requestOriginSessionId);
        assert.strictEqual(articleRow?.metadata.originSessionId, requestOriginSessionId);
        assert.strictEqual(articleRow?.metadata.originKind, 'curator_chat');
        assert.deepStrictEqual(articleRow?.metadata.thread, {
          threadId,
          threadTitle: 'AI coding reliability',
          threadRationale: 'Expands the same debate',
        });
        assert.deepStrictEqual(articleRow?.metadata.riskyTake, { reason: 'Contrarian but relevant angle' });
        assert.strictEqual(articleRow?.metadata.cycleId, cycleId);

        const youtubeRow = rowBySourceId.get(videoId);
        assert.ok(youtubeRow, 'Expected stored YouTube row');
        assert.deepStrictEqual(youtubeRow?.metadata.thread, {
          threadId,
          threadTitle: 'AI coding reliability',
        });
        assert.strictEqual(youtubeRow?.metadata.currentInterestReason, 'Recent currentUser replies mention verification and Mythos');
        assert.strictEqual(youtubeRow?.metadata.cycleId, cycleId);
        assert.strictEqual(
          ((youtubeRow?.metadata.article as Record<string, unknown> | undefined)?.platform),
          'youtube',
        );

        const analysisRow = rowBySourceId.get(analysisSourceId);
        assert.ok(analysisRow, 'Expected stored analysis row');
        assert.deepStrictEqual(analysisRow?.metadata.thread, {
          threadId,
          threadTitle: 'AI coding reliability',
        });
        assert.strictEqual(analysisRow?.metadata.currentInterestReason, 'Synthesis ties together the active lane');
        assert.strictEqual(analysisRow?.metadata.cycleId, cycleId);

        const suggestionRow = rowBySourceId.get(suggestionSourceId);
        assert.ok(suggestionRow, 'Expected stored suggestion row');
        assert.strictEqual(suggestionRow?.metadata.suggestionType, 'code_fix');
        assert.strictEqual(
          suggestionRow?.metadata.proposedValue,
          'Keep suggestion metadata intact while merging unknown keys.',
        );
        assert.deepStrictEqual(suggestionRow?.metadata.thread, {
          threadId,
          threadTitle: 'AI coding reliability',
        });
        assert.strictEqual(suggestionRow?.metadata.cycleId, cycleId);
      } finally {
        await cleanupValidationFixtures({
          sourceIds: [tweetId, articleSourceId, videoId, analysisSourceId, suggestionSourceId],
          originSessionIds: [requestOriginSessionId, itemOriginSessionId],
        }, BASE_URL);
      }
    });
    test('POST /api/internal/curate/submit preserves heartbeat provenance metadata and rejects curator-chat items missing originSessionId', async () => {
      const db = getDb();
      const heartbeatSourceId = `https://example.com/?heartbeat=${randomUUID()}`;
      const missingOriginSourceId = `https://example.com/?missingOrigin=${randomUUID()}`;

      try {
        const heartbeatResponse = await requestJson('/api/internal/curate/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            items: [
              {
                id: `ma-heartbeat-provenance-${randomUUID()}`,
                type: 'article',
                source: 'substack',
                sourceId: heartbeatSourceId,
                title: 'Heartbeat provenance item',
                text: 'Heartbeat-origin item keeps explicit null session provenance.',
                url: heartbeatSourceId,
                reason: 'Heartbeat provenance coverage',
                publishedAt: '2026-03-08T08:00:00.000Z',
                metadata: {
                  cycleId: `curate-${randomUUID()}`,
                  originSessionId: null,
                  originKind: 'heartbeat',
                },
              },
            ],
          }),
        });

        assert.strictEqual(heartbeatResponse.status, 200);
        assertObject(heartbeatResponse.data, 'Expected heartbeat provenance payload');
        assert.strictEqual(heartbeatResponse.data.accepted, 1);

        const heartbeatRow = db.prepare(`
          SELECT origin_session_id AS originSessionId, metadata
          FROM feed
          WHERE source_id = ?
        `).get(heartbeatSourceId) as { originSessionId: string | null; metadata: string | null } | undefined;

        assert.ok(heartbeatRow, 'Expected stored heartbeat provenance row');
        assert.strictEqual(heartbeatRow?.originSessionId, null);
        const heartbeatMetadata = JSON.parse(heartbeatRow?.metadata ?? '{}') as Record<string, unknown>;
        assert.strictEqual(heartbeatMetadata.originSessionId, null);
        assert.strictEqual(heartbeatMetadata.originKind, 'heartbeat');

        const missingOriginResponse = await requestJson('/api/internal/curate/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            items: [
              {
                id: `ma-curator-provenance-missing-${randomUUID()}`,
                type: 'article',
                source: 'substack',
                sourceId: missingOriginSourceId,
                title: 'Missing curator provenance item',
                text: 'Curator-chat submissions must provide an origin session.',
                url: missingOriginSourceId,
                reason: 'Curator provenance validation coverage',
                publishedAt: '2026-03-08T08:30:00.000Z',
                metadata: {
                  cycleId: `curate-${randomUUID()}`,
                  originKind: 'curator_chat',
                },
              },
            ],
          }),
        });

        assert.strictEqual(missingOriginResponse.status, 200);
        assertObject(missingOriginResponse.data, 'Expected missing-origin payload');
        assert.strictEqual(missingOriginResponse.data.accepted, 0);
        assert.ok(Array.isArray(missingOriginResponse.data.errors));
        assert.strictEqual(missingOriginResponse.data.errors[0]?.error, 'Curator-chat submitted items must include originSessionId.');
        const missingOriginRow = db.prepare(`
          SELECT id
          FROM feed
          WHERE source_id = ?
        `).get(missingOriginSourceId);
        assert.strictEqual(missingOriginRow, undefined);
      } finally {
        await cleanupValidationFixtures({
          sourceIds: [heartbeatSourceId, missingOriginSourceId],
        }, BASE_URL);
      }
    });

    test('POST /api/internal/curate/submit deduplicates article source-id legacy and canonical variants in both directions', async () => {
      const db = getDb();
      const articleSlug = `article-test-${randomUUID()}`;
      const legacySourceId = `${articleSlug}.substack.com:/p/dedup-check`;
      const canonicalSourceId = `https://${articleSlug}.substack.com/p/dedup-check`;
      const reverseCanonicalSourceId = `https://reverse-test-${randomUUID()}.substack.com/p/dedup-check`;
      const reverseLegacySourceId = reverseCanonicalSourceId.replace(/^https:\/\//, '').replace('/p/', ':/p/');
      const originSessionId = createValidationOriginSessionId('api-submit-article-dedup');

      db.prepare(`
        INSERT INTO feed (id, type, source, source_id, title, text, url, published_at, created_at)
        VALUES ('legacy-article-existing', 'article', 'substack', ?, 'Legacy article', 'legacy article body', ?, '2026-03-08T10:00:00.000Z', '2026-03-08T10:01:00.000Z')
      `).run(legacySourceId, canonicalSourceId);

      db.prepare(`
        INSERT INTO feed (id, type, source, source_id, title, text, url, published_at, created_at)
        VALUES ('canonical-article-existing', 'article', 'substack', ?, 'Canonical article', 'canonical article body', ?, '2026-03-08T10:00:00.000Z', '2026-03-08T10:01:00.000Z')
      `).run(reverseCanonicalSourceId, reverseCanonicalSourceId);

      try {
        const legacyToCanonicalResponse = await requestJson('/api/internal/curate/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            originSessionId,
            items: [
              {
                id: `article-submit-url-${randomUUID()}`,
                type: 'article',
                source: 'substack',
                sourceId: canonicalSourceId,
                text: 'This canonical-form article should be deduped against the legacy row.',
                url: canonicalSourceId,
                publishedAt: '2026-03-08T11:00:00.000Z',
              },
            ],
          }),
        });

        assert.strictEqual(legacyToCanonicalResponse.status, 200);
        assertObject(legacyToCanonicalResponse.data, 'Expected curation submit payload');
        assert.strictEqual(legacyToCanonicalResponse.data.accepted, 0);
        assert.strictEqual(legacyToCanonicalResponse.data.duplicates, 1);

        const canonicalToLegacyResponse = await requestJson('/api/internal/curate/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            originSessionId,
            items: [
              {
                id: `article-submit-legacy-${randomUUID()}`,
                type: 'article',
                source: 'substack',
                sourceId: reverseLegacySourceId,
                text: 'This legacy-form article should be deduped against the canonical row.',
                url: reverseCanonicalSourceId,
                publishedAt: '2026-03-08T11:05:00.000Z',
              },
            ],
          }),
        });

        assert.strictEqual(canonicalToLegacyResponse.status, 200);
        assertObject(canonicalToLegacyResponse.data, 'Expected curation submit payload');
        assert.strictEqual(canonicalToLegacyResponse.data.accepted, 0);
        assert.strictEqual(canonicalToLegacyResponse.data.duplicates, 1);

        const insertedCount = db.prepare(`
          SELECT COUNT(*) AS count
          FROM feed
          WHERE source_id IN (?, ?, ?, ?)
        `).get(
          legacySourceId,
          canonicalSourceId,
          reverseLegacySourceId,
          reverseCanonicalSourceId,
        ) as { count: number } | undefined;

        assert.strictEqual(insertedCount?.count, 2);
      } finally {
        await cleanupValidationFixtures({
          sourceIds: [
            legacySourceId,
            canonicalSourceId,
            reverseLegacySourceId,
            reverseCanonicalSourceId,
          ],
          originSessionIds: [originSessionId],
        }, BASE_URL);
      }
    });

    test('POST /api/internal/curate/submit reports invalid future publishedAt values as item errors', async () => {
      const futurePublishedAt = new Date(Date.now() + 60_000).toISOString();
      const response = await requestJson('/api/internal/curate/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [
            {
              id: `ma-submit-invalid-${randomUUID()}`,
              type: 'article',
              source: 'publication-slug',
              sourceId: `future-item-${randomUUID()}`,
              parentId: null,
              relationship: 'parent',
              title: 'Future item',
              text: 'This item should be rejected because publishedAt is in the future.',
              url: 'https://example.com/future-item',
              excerpt: null,
              authorUsername: 'future',
              authorDisplayName: 'Future',
              authorAvatarUrl: null,
              reason: 'Invalid test fixture',
              tags: [],
              mediaUrls: [],
              publishedAt: futurePublishedAt,
              metadata: {},
            },
          ],
        }),
      });

      assert.strictEqual(response.status, 200);
      assertObject(response.data, 'Expected curation submit payload');
      assert.strictEqual(response.data.accepted, 0);
      assert.strictEqual(response.data.duplicates, 0);
      assert.ok(Array.isArray(response.data.errors));
      assert.strictEqual(response.data.errors.length, 1);
      assert.strictEqual(response.data.errors[0]?.scope, 'item');
      assert.strictEqual(response.data.errors[0]?.error, 'Field "publishedAt" must not be in the future');
    });

    test('POST /api/internal/curate/submit reports invalid feed types without inserting rows', async () => {
      const db = getDb();
      const sourceId = `invalid-type-${randomUUID()}`;
      const response = await requestJson('/api/internal/curate/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [
            {
              id: `ma-submit-invalid-type-${randomUUID()}`,
              type: 'code_fix',
              source: 'claude',
              sourceId,
              parentId: null,
              relationship: 'parent',
              title: 'Invalid type item',
              text: 'This item should be rejected because code_fix is not a feed type.',
              url: null,
              excerpt: null,
              authorUsername: null,
              authorDisplayName: null,
              authorAvatarUrl: null,
              reason: 'Invalid test fixture',
              tags: [],
              mediaUrls: [],
              publishedAt: '2026-03-08T12:00:00.000Z',
              metadata: {
                suggestionType: 'code_fix',
              },
            },
          ],
        }),
      });

      assert.strictEqual(response.status, 200);
      assertObject(response.data, 'Expected curation submit payload');
      assert.strictEqual(response.data.accepted, 0);
      assert.strictEqual(response.data.duplicates, 0);
      assert.ok(Array.isArray(response.data.errors));
      assert.strictEqual(response.data.errors.length, 1);
      assert.deepStrictEqual(response.data.errors[0], {
        scope: 'item',
        index: 0,
        sourceId,
        error: "Invalid type 'code_fix'. Valid types: tweet, article, analysis, suggestion, notification. For code_fix suggestions, use {type: 'suggestion', metadata: {suggestionType: 'code_fix', ...}}.",
      });

      const inserted = db.prepare('SELECT id FROM feed WHERE source_id = ?').get(sourceId) as { id: string } | undefined;
      assert.strictEqual(inserted, undefined);
    });
  });

  describe('Internal Notifications API', () => {
    test('POST /api/internal/notifications/resolve dismisses matching notifications', async () => {
      const notificationId = `resolve-notification-${randomUUID()}`;
      const feedItemId = createTestFeedItem({
        type: 'notification',
        source: 'system',
        sourceId: notificationId,
        title: 'Resolvable notification',
        text: 'This notification should be dismissed by the resolve API.',
        publishedAt: '2026-03-08T12:20:00.000Z',
        metadata: {
          notificationId,
          severity: 'warning',
          dismissable: true,
        },
      });

      try {
        const response = await requestJson('/api/internal/notifications/resolve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ notificationId }),
        });

        assert.strictEqual(response.status, 200);
        assertObject(response.data, 'Expected notifications resolve payload');
        assert.strictEqual(response.data.ok, true);
        assert.strictEqual(response.data.resolved, true);
        assert.strictEqual(response.data.feedItemId, feedItemId);

        const feedResponse = await requestJson<FeedListResponse>('/api/feed?type=notification&limit=50');
        assert.strictEqual(feedResponse.status, 200);
        assert.ok(!feedResponse.data.items.some((item) => item.id === feedItemId));
      } finally {
        removeTestFeedItem(feedItemId);
      }
    });
  });

  describe('WebSocket Status API', () => {
    test('GET /api/internal/ws-status returns counts for all 4 channels', async () => {
      const response = await requestJson('/api/internal/ws-status');
      assert.strictEqual(response.status, 200);
      assertObject(response.data, 'Expected ws status payload');
      assert.strictEqual(typeof response.data.feedClients, 'number');
      assert.strictEqual(typeof response.data.chatClients, 'number');
      assert.strictEqual(typeof response.data.orchestratorClients, 'number');
      assert.strictEqual(typeof response.data.agentProgressClients, 'number');
      assert.strictEqual(typeof response.data.clients, 'number');
    });
  });
});
