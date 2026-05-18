import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { escapeSqlLikePattern } from '@/lib/search-utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type ChatHistorySearchRow = {
  message_id: string;
  session_id: string | null;
  session_title: string | null;
  role: string;
  created_at: string;
  text: string;
};

const noStoreHeaders = {
  'Cache-Control': 'no-store',
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

function parseSince(value: string | null): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    return new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  }

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return new Date(parsed).toISOString();
}

function normalizeSearchText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function buildSnippet(text: string, query: string): string {
  const normalizedText = normalizeSearchText(text);
  const normalizedQuery = normalizeSearchText(query);
  const matchIndex = normalizedText.toLowerCase().indexOf(normalizedQuery.toLowerCase());

  if (matchIndex === -1) {
    return normalizedText.length <= 120 ? normalizedText : `${normalizedText.slice(0, 117).trimEnd()}...`;
  }

  const start = Math.max(0, matchIndex - 50);
  const end = Math.min(normalizedText.length, matchIndex + normalizedQuery.length + 50);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < normalizedText.length ? '...' : '';
  return `${prefix}${normalizedText.slice(start, end).trim()}${suffix}`;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q')?.trim() ?? '';
  if (!query) {
    return NextResponse.json(
      { ok: false, error: 'Missing required q query parameter' },
      { status: 400, headers: noStoreHeaders },
    );
  }

  const since = parseSince(searchParams.get('since'));
  if (!since) {
    return NextResponse.json(
      { ok: false, error: 'since must be a valid ISO timestamp' },
      { status: 400, headers: noStoreHeaders },
    );
  }

  const sessionId = searchParams.get('sessionId')?.trim() ?? '';
  const limit = parseLimit(searchParams.get('limit'));
  const clauses = [
    "m.type = 'chat'",
    "datetime(COALESCE(m.timestamp, m.created_at)) >= datetime(?)",
    "lower(m.text) LIKE ? ESCAPE '\\'",
  ];
  const params: Array<string | number> = [
    since,
    `%${escapeSqlLikePattern(query.toLowerCase())}%`,
  ];

  if (sessionId) {
    clauses.push('m.session_id = ?');
    params.push(sessionId);
  }
  params.push(limit);

  const rows = getDb().prepare(`
    SELECT
      m.id AS message_id,
      m.session_id,
      s.title AS session_title,
      m.role,
      COALESCE(m.timestamp, m.created_at) AS created_at,
      m.text
    FROM chat_messages AS m
    LEFT JOIN chat_sessions AS s ON s.id = m.session_id
    WHERE ${clauses.join(' AND ')}
    ORDER BY datetime(COALESCE(m.timestamp, m.created_at)) DESC, datetime(m.created_at) DESC, m.id DESC
    LIMIT ?
  `).all(...params) as ChatHistorySearchRow[];

  const results = rows.map((row) => ({
    messageId: row.message_id,
    sessionId: row.session_id,
    sessionTitle: row.session_title,
    role: row.role,
    createdAt: row.created_at,
    text: row.text,
    snippet: buildSnippet(row.text, query),
  }));

  return NextResponse.json({
    ok: true,
    count: results.length,
    results,
  }, { headers: noStoreHeaders });
}
