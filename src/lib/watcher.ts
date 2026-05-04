import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDataPath } from '@/lib/data-dir';
import {
  getFeedItemById,
  hydrateFeedItemsForList,
  insertOrIgnoreFeedItem,
  normalizeFeedInput,
  resolvePersistedFeedItemByIdentifier,
} from '@/lib/db/feed';
import type { FeedInsertInput } from '@/lib/db/feed';
import {
  applyCachedItemEnrichment,
  itemIsStillIncomplete,
  queueFeedItemEnrichment,
} from '@/lib/feed-enrichment';
import type { FeedItem } from '@/types/feed';

const feedOutputPath = getDataPath('feed-output.jsonl');
const defaultFeedNotifyUrl = `http://127.0.0.1:${process.env.PORT || '3001'}/api/internal/feed-notify`;

let feedWatcherStarted = false;
let feedFileWatcher: fs.FSWatcher | null = null;
let feedPollTimer: NodeJS.Timeout | null = null;
let feedReadOffset = 0;
let feedPartialLineBuffer = '';
let feedFlushScheduled = false;

const enableLegacyFeedStartupImport = process.env.MEDIA_AGENT_ENABLE_FEED_WATCHER_STARTUP_IMPORT === '1';

async function ensureFeedOutputFile() {
  await fs.promises.mkdir(path.dirname(feedOutputPath), { recursive: true });
  await fs.promises.appendFile(feedOutputPath, '');
}

function payloadFromInsert(input: FeedInsertInput): FeedItem {
  return {
    id: input.id ?? '',
    type: input.type,
    source: input.source ?? null,
    sourceId: input.sourceId ?? null,
    originSessionId: input.originSessionId ?? null,
    parentId: input.parentId ?? null,
    relationship: input.relationship ?? null,
    title: input.title ?? null,
    text: input.text,
    url: input.url ?? null,
    excerpt: input.excerpt ?? null,
    authorUsername: input.authorUsername ?? null,
    authorDisplayName: input.authorDisplayName ?? null,
    reason: input.reason ?? null,
    tags: input.tags ?? [],
    mediaUrls: input.mediaUrls ?? [],
    metrics: input.metrics ?? {
      likes: 0,
      reposts: 0,
      replies: 0,
    },
    authorAvatarUrl: input.authorAvatarUrl ?? null,
    isLiked: false,
    isDisliked: false,
    metadata: input.metadata ?? null,
    publishedAt: input.publishedAt,
    createdAt: new Date().toISOString(),
  };
}

async function notifyFeedUpdate(items: FeedItem[]) {
  if (items.length === 0) return;

  const notifyUrl = process.env.INTERNAL_FEED_NOTIFY_URL || defaultFeedNotifyUrl;
  const hydratedItems = hydrateFeedItemsForList(items);

  try {
    const resp = await fetch(notifyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: hydratedItems, count: hydratedItems.length }),
    });
    const result = await resp.json() as Record<string, unknown>;
    console.log(`[watcher] notified ${hydratedItems.length} items → ${result.deliveredToClients ?? 0} clients (ok=${result.ok})`);
  } catch (error) {
    console.error('[watcher] failed to notify websocket server', error);
  }
}

function queueFeedItemEnrichmentInBackground(item: FeedItem) {
  if (!itemIsStillIncomplete(item)) return;

  void queueFeedItemEnrichment(item, {
    endpoint: 'feed-watcher',
    mode: 'lightweight',
    routeId: item.id,
    source: 'post_enrichment',
    tracking: 'automatic',
    trigger: 'feed_watcher_auto_queue',
  }).then((result) => {
    if (!result.ok) {
      console.warn(`[watcher] failed to queue enrichment for tweet ${item.id}: ${result.error ?? 'unknown error'}`);
    }
  }).catch((error) => {
    console.error('[watcher] background enrichment queue error:', error instanceof Error ? error.message : String(error));
  });
}

async function getTweetNotificationPayload(insertedItem: FeedItem): Promise<FeedItem> {
  if (!insertedItem.id) {
    return insertedItem;
  }

  const cachePatchedItem = applyCachedItemEnrichment(insertedItem) ?? insertedItem;
  queueFeedItemEnrichmentInBackground(cachePatchedItem);
  return getFeedItemById(insertedItem.id) ?? cachePatchedItem;
}

type ReadNewFeedLinesOptions = {
  broadcast?: boolean;
};

function resolveParentIdForInsert(parentId: string | null | undefined): string | null {
  const trimmed = parentId?.trim();
  if (!trimmed) {
    return null;
  }

  const parentItem = resolvePersistedFeedItemByIdentifier(trimmed);
  return parentItem?.id ?? null;
}

async function readNewFeedLines({ broadcast = true }: ReadNewFeedLinesOptions = {}) {
  try {
    const stat = await fs.promises.stat(feedOutputPath);

    // JSONL rewrites/truncation are treated as a fresh stream.
    if (stat.size < feedReadOffset) {
      feedReadOffset = 0;
      feedPartialLineBuffer = '';
    }

    if (stat.size === feedReadOffset) {
      return;
    }

    const bytesToRead = stat.size - feedReadOffset;
    console.log(`[watcher] reading ${bytesToRead} new bytes (offset ${feedReadOffset} → ${stat.size})`);
    const fileHandle = await fs.promises.open(feedOutputPath, 'r');

    try {
      const chunk = Buffer.alloc(bytesToRead);
      await fileHandle.read(chunk, 0, bytesToRead, feedReadOffset);
      feedReadOffset = stat.size;

      const merged = feedPartialLineBuffer + chunk.toString('utf8');
      const lines = merged.split('\n');
      feedPartialLineBuffer = lines.pop() ?? '';

      const insertedNonTweets: FeedItem[] = [];
      const insertedTweets: FeedItem[] = [];

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        try {
          const parsed = JSON.parse(line) as unknown;
          const normalized = normalizeFeedInput(parsed);
          if (!normalized) continue;
          if (normalized.id && getFeedItemById(normalized.id)) {
            continue;
          }

          const resolvedParentId = resolveParentIdForInsert(normalized.parentId);
          if (normalized.parentId && !resolvedParentId) {
            console.warn(
              `[watcher] skipping JSONL line with unresolved parentId "${normalized.parentId}" (sourceId=${normalized.sourceId ?? 'n/a'}, relationship=${normalized.relationship ?? 'n/a'})`,
            );
            continue;
          }
          if (normalized.parentId && resolvedParentId && resolvedParentId !== normalized.parentId) {
            console.log(`[watcher] resolved parentId "${normalized.parentId}" -> "${resolvedParentId}"`);
          }

          // Ignore agent-suggested IDs; source_id handles semantic deduplication.
          const normalizedForInsert: FeedInsertInput = {
            ...normalized,
            id: randomUUID(),
            parentId: resolvedParentId,
          };

          const wasInserted = insertOrIgnoreFeedItem(normalizedForInsert);
          if (wasInserted) {
            const payload = payloadFromInsert(normalizedForInsert);
            if (payload.type === 'tweet') {
              insertedTweets.push(payload);
            } else {
              insertedNonTweets.push(payload);
            }
          }
        } catch (error) {
          console.warn('[watcher] skipping invalid JSONL line', error);
        }
      }

      const nonEmptyLines = lines.filter(l => l.trim().length > 0).length;
      const insertedCount = insertedNonTweets.length + insertedTweets.length;
      console.log(`[watcher] parsed ${nonEmptyLines} lines, inserted ${insertedCount} new items`);

      if (!broadcast) {
        return;
      }

      if (insertedNonTweets.length > 0) {
        await notifyFeedUpdate(insertedNonTweets);
      }

      if (insertedTweets.length > 0) {
        const tweetPayloads: FeedItem[] = [];
        for (const insertedTweet of insertedTweets) {
          tweetPayloads.push(await getTweetNotificationPayload(insertedTweet));
        }
        await notifyFeedUpdate(tweetPayloads);
      }
    } finally {
      await fileHandle.close();
    }
  } catch (error) {
    console.error('[watcher] read failure', error);
  }
}

function scheduleFeedRead() {
  if (feedFlushScheduled) return;
  feedFlushScheduled = true;
  setTimeout(async () => {
    feedFlushScheduled = false;
    await readNewFeedLines();
  }, 30);
}

export async function startFeedWatcher() {
  if (feedWatcherStarted) return;
  feedWatcherStarted = true;

  await ensureFeedOutputFile();

  try {
    const stat = await fs.promises.stat(feedOutputPath);
    feedReadOffset = enableLegacyFeedStartupImport ? 0 : stat.size;
    feedPartialLineBuffer = '';
    if (enableLegacyFeedStartupImport && stat.size > 0) {
      await readNewFeedLines({ broadcast: false });
    }
  } catch (error) {
    console.error('[watcher] initial read failed', error);
  }

  feedFileWatcher = fs.watch(feedOutputPath, () => {
    scheduleFeedRead();
  });

  feedFileWatcher.on('error', (error) => {
    console.error('[watcher] fs.watch error', error);
  });

  // Polling fallback in case fs.watch drops events.
  feedPollTimer = setInterval(() => {
    scheduleFeedRead();
  }, 5000);

  console.log(`[watcher] started for ${feedOutputPath}`);
}

export function stopFeedWatcher() {
  if (feedFileWatcher) {
    feedFileWatcher.close();
    feedFileWatcher = null;
  }

  if (feedPollTimer) {
    clearInterval(feedPollTimer);
    feedPollTimer = null;
  }

  feedReadOffset = 0;
  feedPartialLineBuffer = '';
  feedFlushScheduled = false;
  feedWatcherStarted = false;
}
