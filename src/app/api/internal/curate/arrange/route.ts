import { NextResponse } from 'next/server';
import {
  arrangeFeedDisplay,
  type FeedArrangeOrderingInput,
  type FeedArrangeThreadInput,
} from '@/lib/db/feed';
import { notifyFeedArranged } from '@/lib/curation-submit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${fieldName} must not be empty`);
  }
  return trimmed;
}

function readOptionalString(value: unknown, fieldName: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string when provided`);
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function readDisplayOrder(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${fieldName} must be a finite number`);
  }
  return Math.trunc(value);
}

function readBoolean(value: unknown, fieldName: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${fieldName} must be a boolean`);
  }
  return value;
}

function normalizeOrdering(rawOrdering: unknown): FeedArrangeOrderingInput[] {
  if (!Array.isArray(rawOrdering)) {
    throw new Error('ordering must be an array');
  }

  const seen = new Set<string>();
  return rawOrdering.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`ordering[${index}] must be an object`);
    }
    const feedItemId = readRequiredString(entry.feedItemId, `ordering[${index}].feedItemId`);
    if (seen.has(feedItemId)) {
      throw new Error(`ordering[${index}].feedItemId duplicates ${feedItemId}`);
    }
    seen.add(feedItemId);

    return {
      feedItemId,
      displayOrder: readDisplayOrder(entry.displayOrder, `ordering[${index}].displayOrder`),
      threadId: readOptionalString(entry.threadId, `ordering[${index}].threadId`),
      displaySubtitle: readOptionalString(entry.displaySubtitle, `ordering[${index}].displaySubtitle`),
    };
  });
}

function normalizeThreads(rawThreads: unknown): FeedArrangeThreadInput[] {
  if (!Array.isArray(rawThreads)) {
    throw new Error('threads must be an array');
  }

  const seen = new Set<string>();
  return rawThreads.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`threads[${index}] must be an object`);
    }
    const id = readRequiredString(entry.id, `threads[${index}].id`);
    if (seen.has(id)) {
      throw new Error(`threads[${index}].id duplicates ${id}`);
    }
    seen.add(id);

    return {
      id,
      title: readRequiredString(entry.title, `threads[${index}].title`),
      subtitle: readOptionalString(entry.subtitle, `threads[${index}].subtitle`),
      active: readBoolean(entry.active, `threads[${index}].active`),
    };
  });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON payload' }, { status: 400 });
  }

  try {
    if (!isRecord(body)) {
      throw new Error('Request body must be a JSON object');
    }

    const ordering = normalizeOrdering(body.ordering);
    const threads = normalizeThreads(body.threads);
    const activeThreadIds = new Set(threads.filter((thread) => thread.active).map((thread) => thread.id));

    for (const [index, item] of ordering.entries()) {
      if (item.threadId && !activeThreadIds.has(item.threadId)) {
        throw new Error(`ordering[${index}].threadId must reference an active listed thread`);
      }
    }

    const result = arrangeFeedDisplay({ ordering, threads });
    const snapshot = {
      ordering,
      activeThreads: result.activeThreads,
      updatedItemIds: result.updatedItemIds,
      orderingCount: result.orderingCount,
      threadCount: result.threadCount,
    };

    await notifyFeedArranged(snapshot);

    return NextResponse.json({
      ok: true,
      ...snapshot,
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to arrange feed',
    }, { status: 400 });
  }
}
