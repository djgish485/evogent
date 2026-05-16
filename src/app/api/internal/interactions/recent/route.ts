import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type InteractionRow = {
  id: number;
  feed_item_id: string;
  action: string;
  created_at: string | null;
  feed_title: string | null;
  feed_type: string | null;
  feed_source: string | null;
  feed_source_id: string | null;
  feed_author_username: string | null;
  feed_author_display_name: string | null;
  feed_text: string | null;
};

function parseLimit(value: string | null): number {
  if (typeof value !== 'string' || !value.trim()) {
    return 50;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 50;
  }

  return Math.min(200, Math.max(1, Math.floor(parsed)));
}

function truncateText(value: string | null, maxLength = 280): string | null {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (!text) {
    return null;
  }
  return text.length > maxLength ? `${text.slice(0, maxLength - 3).trimEnd()}...` : text;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const limit = parseLimit(searchParams.get('limit'));
  const rows = getDb().prepare(`
    SELECT
      interactions.id,
      interactions.feed_item_id,
      interactions.action,
      interactions.created_at,
      feed.title AS feed_title,
      feed.type AS feed_type,
      feed.source AS feed_source,
      feed.source_id AS feed_source_id,
      feed.author_username AS feed_author_username,
      feed.author_display_name AS feed_author_display_name,
      feed.text AS feed_text
    FROM interactions
    LEFT JOIN feed ON feed.id = interactions.feed_item_id
    ORDER BY datetime(interactions.created_at) DESC, interactions.id DESC
    LIMIT ?
  `).all(limit) as InteractionRow[];

  const interactions = rows.map((row) => ({
    id: row.id,
    feedItemId: row.feed_item_id,
    action: row.action,
    createdAt: row.created_at,
    feedItem: {
      id: row.feed_item_id,
      title: row.feed_title,
      type: row.feed_type,
      source: row.feed_source,
      sourceId: row.feed_source_id,
      authorUsername: row.feed_author_username,
      authorDisplayName: row.feed_author_display_name,
      text: truncateText(row.feed_text),
    },
  }));

  return NextResponse.json({
    ok: true,
    count: interactions.length,
    interactions,
  });
}
