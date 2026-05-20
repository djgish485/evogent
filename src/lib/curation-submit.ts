import fs from 'node:fs';
import path from 'node:path';
import { getDataPath } from '@/lib/data-dir';
import { hydrateFeedItemsForList, normalizeTweetSourceId, resolvePersistedFeedItemByIdentifier } from '@/lib/db/feed';
import type { FeedInsertInput } from '@/lib/db/feed';
import type { FeedItem } from '@/types/feed';

const defaultFeedNotifyUrl = `http://127.0.0.1:${process.env.PORT || '3001'}/api/internal/feed-notify`;
const defaultFeedArrangedNotifyUrl = `http://127.0.0.1:${process.env.PORT || '3001'}/api/internal/feed-arranged`;

export const feedOutputPath = getDataPath('feed-output.jsonl');
export const curationCandidatesPath = getDataPath('curation-candidates.jsonl');

async function appendJsonl(filePath: string, entries: unknown[]) {
  if (entries.length === 0) {
    return;
  }

  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const payload = entries.map((entry) => `${JSON.stringify(entry)}\n`).join('');
  await fs.promises.appendFile(filePath, payload, 'utf8');
}

export async function appendAcceptedFeedItems(items: FeedInsertInput[]) {
  await appendJsonl(feedOutputPath, items);
}

export async function appendCurationCandidateEntries(entries: unknown[]) {
  await appendJsonl(curationCandidatesPath, entries);
}

export async function notifyFeedUpdate(items: FeedItem[]) {
  if (items.length === 0) {
    return;
  }

  const notifyUrl = process.env.INTERNAL_FEED_NOTIFY_URL || defaultFeedNotifyUrl;
  const hydratedItems = hydrateFeedItemsForList(items);

  try {
    await fetch(notifyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: hydratedItems, count: hydratedItems.length }),
    });
  } catch (error) {
    console.warn('[curation-submit] failed to notify websocket clients', error);
  }
}

export async function notifyFeedArranged(snapshot: unknown) {
  const notifyUrl = process.env.INTERNAL_FEED_ARRANGED_NOTIFY_URL || defaultFeedArrangedNotifyUrl;

  try {
    await fetch(notifyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(snapshot ?? {}),
    });
  } catch (error) {
    console.warn('[curation-submit] failed to notify feed arrangement websocket clients', error);
  }
}

export function rememberAcceptedIdentifiers(
  acceptedIdentifiers: Map<string, string>,
  item: FeedInsertInput,
) {
  const persistedId = item.id?.trim();
  if (!persistedId) {
    return;
  }

  acceptedIdentifiers.set(persistedId, persistedId);

  const sourceId = item.sourceId?.trim();
  if (sourceId) {
    acceptedIdentifiers.set(sourceId, persistedId);
    if (item.type === 'tweet') {
      acceptedIdentifiers.set(normalizeTweetSourceId(sourceId), persistedId);
    }
  }

  const url = item.url?.trim();
  if (url) {
    acceptedIdentifiers.set(url, persistedId);
  }
}

export function resolveParentIdForBatchInsert(
  parentId: string | null | undefined,
  acceptedIdentifiers: Map<string, string>,
): string | null {
  const trimmed = parentId?.trim();
  if (!trimmed) {
    return null;
  }

  const batchResolved = acceptedIdentifiers.get(trimmed) ?? acceptedIdentifiers.get(normalizeTweetSourceId(trimmed));
  if (batchResolved) {
    return batchResolved;
  }

  const persisted = resolvePersistedFeedItemByIdentifier(trimmed);
  return persisted?.id ?? null;
}
