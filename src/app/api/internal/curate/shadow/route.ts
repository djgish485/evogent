import fs from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { getDataPath } from '@/lib/data-dir';
import {
  getFeedItemBySourceId,
  normalizeArticleSourceId,
  normalizeFeedInput,
  normalizeTweetSourceId,
  normalizeType,
} from '@/lib/db/feed';
import type { FeedInsertInput } from '@/lib/db/feed';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type SubmitError = {
  scope: 'item' | 'system';
  index?: number;
  sourceId?: string | null;
  error: string;
};

const iso8601Pattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readSourceId(input: Record<string, unknown>): string | null {
  return typeof input.sourceId === 'string'
    ? input.sourceId
    : typeof input.source_id === 'string'
      ? input.source_id
      : null;
}

function buildInvalidTypeMessage(type: unknown): string {
  const value = typeof type === 'string' ? type.trim() || type : String(type);
  return `Invalid type '${value}'. Valid types: tweet, article, analysis, suggestion, notification.`;
}

function parseIso8601Timestamp(
  value: unknown,
  field: string,
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== 'string' || !value.trim()) {
    return { ok: false, error: `Field "${field}" must be a non-empty ISO-8601 string` };
  }

  const trimmed = value.trim();
  if (!iso8601Pattern.test(trimmed)) {
    return { ok: false, error: `Field "${field}" must be a valid ISO-8601 timestamp` };
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return { ok: false, error: `Field "${field}" must be a valid ISO-8601 timestamp` };
  }

  if (parsed.getTime() > Date.now()) {
    return { ok: false, error: `Field "${field}" must not be in the future` };
  }

  return { ok: true, value: parsed.toISOString() };
}

function parseFeedInsertInput(
  input: unknown,
  index: number,
): { ok: true; normalized: FeedInsertInput } | { ok: false; error: SubmitError } {
  if (!isRecord(input)) {
    return {
      ok: false,
      error: { scope: 'item', index, error: 'Item must be a JSON object' },
    };
  }

  const sourceId = readSourceId(input);
  const publishedAtRaw = input.publishedAt ?? input.published_at;
  const publishedAt = parseIso8601Timestamp(publishedAtRaw, 'publishedAt');
  if (!publishedAt.ok) {
    return {
      ok: false,
      error: {
        scope: 'item',
        index,
        sourceId,
        error: publishedAt.error,
      },
    };
  }

  const normalizedType = normalizeType(input.type);
  if (!normalizedType) {
    return {
      ok: false,
      error: {
        scope: 'item',
        index,
        sourceId,
        error: buildInvalidTypeMessage(input.type),
      },
    };
  }

  const normalized = normalizeFeedInput({
    ...input,
    type: normalizedType,
    publishedAt: publishedAt.value,
  });

  if (!normalized) {
    return {
      ok: false,
      error: {
        scope: 'item',
        index,
        sourceId,
        error: 'Item failed feed normalization',
      },
    };
  }

  return { ok: true, normalized };
}

function readRequestOriginSessionId(payload: Record<string, unknown>): string | null {
  const candidates = [
    payload.originSessionId,
    payload.origin_session_id,
    payload.originConversationId,
    payload.origin_conversation_id,
  ];

  const value = candidates.find((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
  return value?.trim() ?? null;
}

function applyRequestOriginSessionId(
  item: FeedInsertInput,
  requestOriginSessionId: string | null,
): FeedInsertInput {
  if (item.originSessionId || !requestOriginSessionId) {
    return item;
  }

  return {
    ...item,
    originSessionId: requestOriginSessionId,
    metadata: {
      ...(item.metadata ?? {}),
      originSessionId: requestOriginSessionId,
    },
  };
}

function canonicalizeSourceId(item: FeedInsertInput): string | null {
  if (!item.sourceId) {
    return null;
  }

  const canonicalSourceId = item.type === 'tweet'
    ? normalizeTweetSourceId(item.sourceId)
    : normalizeArticleSourceId(item.sourceId);
  item.sourceId = canonicalSourceId;
  return canonicalSourceId;
}

async function appendShadowSubmission(payload: Record<string, unknown>) {
  const logDir = getDataPath('shadow-curator-log');
  const fileName = `${new Date().toISOString().slice(0, 10)}.jsonl`;
  await fs.mkdir(logDir, { recursive: true });
  await fs.appendFile(path.join(logDir, fileName), `${JSON.stringify(payload)}\n`, 'utf8');
}

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!isRecord(payload)) {
    return NextResponse.json({ error: 'Request body must be a JSON object' }, { status: 400 });
  }

  if (!Array.isArray(payload.items)) {
    return NextResponse.json({ error: 'Field "items" must be an array' }, { status: 400 });
  }

  if (payload.candidates !== undefined && !Array.isArray(payload.candidates)) {
    return NextResponse.json({ error: 'Field "candidates" must be an array when provided' }, { status: 400 });
  }

  const errors: SubmitError[] = [];
  const acceptedItems: FeedInsertInput[] = [];
  const acceptedIds: string[] = [];
  const duplicateSourceIds = new Set<string>();
  const seenSourceIds = new Set<string>();
  const requestOriginSessionId = readRequestOriginSessionId(payload);
  let duplicates = 0;

  for (const [index, rawItem] of payload.items.entries()) {
    const parsed = parseFeedInsertInput(rawItem, index);
    if (!parsed.ok) {
      errors.push(parsed.error);
      continue;
    }

    const normalized = applyRequestOriginSessionId(parsed.normalized, requestOriginSessionId);
    const canonicalSourceId = canonicalizeSourceId(normalized);
    if (canonicalSourceId) {
      if (seenSourceIds.has(canonicalSourceId) || getFeedItemBySourceId(canonicalSourceId)) {
        duplicates += 1;
        duplicateSourceIds.add(canonicalSourceId);
        continue;
      }
      seenSourceIds.add(canonicalSourceId);
    }

    acceptedItems.push(normalized);
    acceptedIds.push(normalized.id ?? canonicalSourceId ?? `shadow-${index}`);
  }

  if (acceptedItems.length > 0) {
    const shadowPayload: Record<string, unknown> = {
      items: acceptedItems,
    };
    if (Array.isArray(payload.candidates)) {
      shadowPayload.candidates = payload.candidates;
    }
    if (payload.cycleSummary !== undefined) {
      shadowPayload.cycleSummary = payload.cycleSummary;
    }
    if (requestOriginSessionId) {
      shadowPayload.originSessionId = requestOriginSessionId;
    }

    try {
      await appendShadowSubmission(shadowPayload);
    } catch (error) {
      errors.push({
        scope: 'system',
        error: error instanceof Error ? error.message : 'Failed to append shadow curator log',
      });
    }
  }

  return NextResponse.json({
    accepted: acceptedItems.length,
    duplicates,
    errors,
    acceptedIds,
    duplicateSourceIds: Array.from(duplicateSourceIds),
  });
}
