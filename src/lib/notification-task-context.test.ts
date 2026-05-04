import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';

import { enrichFeedItemsWithNotificationTaskContext } from './notification-task-context';
import type { FeedItem } from '@/types/feed';

const originalDataDir = process.env.DATA_DIR;
const originalFetch = global.fetch;

function createNotificationItem(): FeedItem {
  return {
    id: 'notification-1',
    type: 'notification',
    source: 'system',
    sourceId: 'notification-1',
    parentId: null,
    relationship: null,
    title: 'Curation status',
    text: 'Background curation completed.',
    url: null,
    excerpt: 'Open the detail view for the latest transcript tail.',
    authorUsername: null,
    authorDisplayName: null,
    reason: null,
    tags: [],
    mediaUrls: [],
    metrics: { likes: 0, reposts: 0, replies: 0 },
    authorAvatarUrl: null,
    isLiked: false,
    isDisliked: false,
    suggestionStatus: undefined,
    parentItem: null,
    children: [],
    childrenCount: 0,
    suggestionChildren: [],
    analysisPresentation: null,
    notificationTaskContext: null,
    metadata: {
      severity: 'info',
      dismissable: true,
      notificationId: 'notification-1',
      taskId: 'curation-123',
      taskSummary: 'Queued curation finished cleanly.',
    },
    publishedAt: '2026-03-29T12:00:00.000Z',
    createdAt: '2026-03-29T12:00:00.000Z',
  };
}

afterEach(async () => {
  process.env.DATA_DIR = originalDataDir;
  global.fetch = originalFetch;
});

describe('notification task context', () => {
  test('hydrates notification detail lines from persisted task logs', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'notification-task-context-'));
    process.env.DATA_DIR = tempDir;
    global.fetch = async () => new Response(null, { status: 404 });

    await fs.mkdir(path.join(tempDir, 'task-logs'), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, 'task-logs', 'curation-123.jsonl'),
      [
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-03-29T11:56:00.000Z',
          message: {
            content: [
              { type: 'text', text: 'Opened the source queue and selected the next curation window.' },
            ],
          },
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-03-29T11:58:00.000Z',
          message: {
            content: [
              { type: 'text', text: 'Persisted 4 new items to the feed.' },
            ],
          },
        }),
      ].join('\n'),
      'utf8',
    );

    const [item] = await enrichFeedItemsWithNotificationTaskContext([createNotificationItem()]);

    assert.ok(item.notificationTaskContext);
    assert.strictEqual(item.notificationTaskContext?.taskId, 'curation-123');
    assert.strictEqual(item.notificationTaskContext?.summary, 'Queued curation finished cleanly.');
    assert.deepStrictEqual(item.notificationTaskContext?.lines, [
      'Opened the source queue and selected the next curation window.',
      'Persisted 4 new items to the feed.',
    ]);
  });
});
