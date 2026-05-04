import { NextResponse } from 'next/server';
import {
  getFeedChildren,
  hydrateFeedItemsForList,
  getInteractionStates,
  getSuggestionStates,
  groupFeedChildrenByRelationship,
  resolveFeedItemByIdentifier,
  updateFeedItemFields,
  type FeedItemPatchInput,
} from '@/lib/db/feed';
import { enrichFeedItemsWithNotificationTaskContext } from '@/lib/notification-task-context';
import type { FeedItem } from '@/types/feed';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const defaultFeedNotifyUrl = `http://127.0.0.1:${process.env.PORT || '3001'}/api/internal/feed-notify`;
const allowedPatchFields = new Set([
  'author_username',
  'author_display_name',
  'text',
  'title',
  'excerpt',
  'reason',
  'tags',
  'media_urls',
  'mediaUrls',
  'author_avatar_url',
  'metadata',
  'metrics_likes',
  'metrics_reposts',
  'metrics_replies',
  'metrics_views',
  'likeCount',
  'repostCount',
  'replyCount',
]);

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parsePatchBody(input: unknown): { ok: true; patch: FeedItemPatchInput } | { ok: false; error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'PATCH body must be a JSON object' };
  }

  const raw = input as Record<string, unknown>;
  const keys = Object.keys(raw);
  if (keys.length === 0) {
    return { ok: false, error: 'PATCH body is empty' };
  }

  const disallowedKey = keys.find((key) => !allowedPatchFields.has(key));
  if (disallowedKey) {
    return { ok: false, error: `Field "${disallowedKey}" is not updatable` };
  }

  const patch: FeedItemPatchInput = {};
  const hasOwn = (key: string) => Object.prototype.hasOwnProperty.call(raw, key);

  const parseNullableString = (value: unknown, field: string): string | null | undefined => {
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (typeof value !== 'string') throw new Error(`Field "${field}" must be a string or null`);
    return value;
  };

  const parseCount = (value: unknown, field: string): number => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`Field "${field}" must be a finite number`);
    }
    return Math.max(0, Math.floor(value));
  };

  try {
    if (hasOwn('author_username')) {
      patch.author_username = parseNullableString(raw.author_username, 'author_username');
    }
    if (hasOwn('author_display_name')) {
      patch.author_display_name = parseNullableString(raw.author_display_name, 'author_display_name');
    }
    if (hasOwn('title')) {
      patch.title = parseNullableString(raw.title, 'title');
    }
    if (hasOwn('excerpt')) {
      patch.excerpt = parseNullableString(raw.excerpt, 'excerpt');
    }
    if (hasOwn('reason')) {
      patch.reason = parseNullableString(raw.reason, 'reason');
    }
    if (hasOwn('author_avatar_url')) {
      patch.author_avatar_url = parseNullableString(raw.author_avatar_url, 'author_avatar_url');
    }

    if (hasOwn('text')) {
      if (typeof raw.text !== 'string' || !raw.text.trim()) {
        return { ok: false, error: 'Field "text" must be a non-empty string' };
      }
      patch.text = raw.text;
    }

    if (hasOwn('tags')) {
      if (!(raw.tags === null || typeof raw.tags === 'string' || isStringArray(raw.tags))) {
        return { ok: false, error: 'Field "tags" must be an array of strings, string, or null' };
      }
      patch.tags = raw.tags as string[] | string | null;
    }

    if (hasOwn('media_urls')) {
      if (!(raw.media_urls === null || typeof raw.media_urls === 'string' || isStringArray(raw.media_urls))) {
        return { ok: false, error: 'Field "media_urls" must be an array of strings, string, or null' };
      }
      patch.media_urls = raw.media_urls as string[] | string | null;
    }

    if (hasOwn('mediaUrls')) {
      if (!(raw.mediaUrls === null || typeof raw.mediaUrls === 'string' || isStringArray(raw.mediaUrls))) {
        return { ok: false, error: 'Field "mediaUrls" must be an array of strings, string, or null' };
      }
      patch.media_urls = raw.mediaUrls as string[] | string | null;
    }

    if (hasOwn('metadata')) {
      if (!(raw.metadata === null || isJsonObject(raw.metadata))) {
        return { ok: false, error: 'Field "metadata" must be a JSON object or null' };
      }
      patch.metadata = raw.metadata as Record<string, unknown> | null;
    }

    if (hasOwn('metrics_likes') || hasOwn('likeCount')) {
      const value = hasOwn('metrics_likes') ? raw.metrics_likes : raw.likeCount;
      patch.metrics_likes = parseCount(value, hasOwn('metrics_likes') ? 'metrics_likes' : 'likeCount');
    }

    if (hasOwn('metrics_reposts') || hasOwn('repostCount')) {
      const value = hasOwn('metrics_reposts') ? raw.metrics_reposts : raw.repostCount;
      patch.metrics_reposts = parseCount(value, hasOwn('metrics_reposts') ? 'metrics_reposts' : 'repostCount');
    }

    if (hasOwn('metrics_replies') || hasOwn('replyCount')) {
      const value = hasOwn('metrics_replies') ? raw.metrics_replies : raw.replyCount;
      patch.metrics_replies = parseCount(value, hasOwn('metrics_replies') ? 'metrics_replies' : 'replyCount');
    }

    if (hasOwn('metrics_views')) {
      patch.metrics_views = parseCount(raw.metrics_views, 'metrics_views');
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Invalid PATCH body' };
  }

  if (Object.keys(patch).length === 0) {
    return { ok: false, error: 'No valid updatable fields were provided' };
  }

  return { ok: true, patch };
}

async function notifyFeedUpdate(item: FeedItem) {
  const notifyUrl = process.env.INTERNAL_FEED_NOTIFY_URL || defaultFeedNotifyUrl;
  const [hydratedItem] = hydrateFeedItemsForList([item]);
  try {
    await fetch(notifyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: hydratedItem ? [hydratedItem] : [item], count: 1 }),
    });
  } catch (error) {
    console.warn('[feed.patch] failed to notify websocket clients', error);
  }
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const item = resolveFeedItemByIdentifier(id);

  if (!item) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const children = getFeedChildren(item.id);
  const hydratedDetailItems = await enrichFeedItemsWithNotificationTaskContext(
    hydrateFeedItemsForList([item, ...children]),
  );
  const hydratedItem = hydratedDetailItems.find((entry) => entry.id === item.id) ?? item;
  const hydratedChildren = hydratedDetailItems.filter((entry) => entry.id !== item.id);
  const interactionStates = getInteractionStates([item.id, ...hydratedChildren.map((child) => child.id)]);
  const suggestionStates = getSuggestionStates([item.id, ...hydratedChildren.map((child) => child.id)]);
  const likedChildren = hydratedChildren.map((child) => ({
    ...child,
    isLiked: interactionStates[child.id]?.liked ?? false,
    isDisliked: interactionStates[child.id]?.disliked ?? false,
    suggestionStatus: child.type === 'suggestion' || child.type === 'notification'
      ? suggestionStates[child.id] ?? 'pending'
      : undefined,
  }));
  const groupedChildren = groupFeedChildrenByRelationship(likedChildren);

  return NextResponse.json({
    item: {
      ...hydratedItem,
      isLiked: interactionStates[item.id]?.liked ?? false,
      isDisliked: interactionStates[item.id]?.disliked ?? false,
      suggestionStatus: hydratedItem.type === 'suggestion' || hydratedItem.type === 'notification'
        ? suggestionStates[item.id] ?? 'pending'
        : undefined,
    },
    children: likedChildren,
    childrenByRelationship: groupedChildren,
  });
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const item = resolveFeedItemByIdentifier(id);

  if (!item) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = parsePatchBody(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const updated = updateFeedItemFields(item.id, parsed.patch);
  if (!updated) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const interactionStates = getInteractionStates([updated.id]);
  const suggestionStates = getSuggestionStates([updated.id]);
  const responseItem = {
    ...updated,
    isLiked: interactionStates[updated.id]?.liked ?? false,
    isDisliked: interactionStates[updated.id]?.disliked ?? false,
    suggestionStatus: updated.type === 'suggestion' || updated.type === 'notification'
      ? suggestionStates[updated.id] ?? 'pending'
      : undefined,
  };

  await notifyFeedUpdate(responseItem);

  return NextResponse.json({ item: responseItem });
}
