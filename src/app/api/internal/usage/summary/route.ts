import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type UsageSummaryRow = {
  priority: string;
  model: string | null;
  runs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheRead: number | null;
  cacheCreate: number | null;
  estCost: number | null;
};

function parseSinceMs(value: string | null): number | null {
  const trimmed = value?.trim() || '24h';
  const relativeMatch = trimmed.match(/^(\d+)([hd])$/i);
  if (relativeMatch) {
    const amount = Number(relativeMatch[1]);
    if (!Number.isFinite(amount) || amount <= 0) {
      return null;
    }
    const unitMs = relativeMatch[2].toLowerCase() === 'd'
      ? 24 * 60 * 60 * 1000
      : 60 * 60 * 1000;
    return Date.now() - amount * unitMs;
  }

  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const sinceMs = parseSinceMs(url.searchParams.get('since'));
  if (sinceMs === null) {
    return NextResponse.json({ ok: false, error: 'Invalid since parameter' }, { status: 400 });
  }

  const rows = getDb().prepare(`
    SELECT
      priority,
      model,
      COUNT(*) AS runs,
      SUM(input_tokens) AS inputTokens,
      SUM(output_tokens) AS outputTokens,
      SUM(cache_read_tokens) AS cacheRead,
      SUM(cache_create_tokens) AS cacheCreate,
      SUM(estimated_cost_usd) AS estCost
    FROM claude_task_usage
    WHERE started_at_ms >= ?
    GROUP BY priority, model
    ORDER BY estCost DESC
  `).all(sinceMs) as UsageSummaryRow[];

  const breakdown = rows.map((row) => ({
    priority: row.priority,
    model: row.model,
    runs: row.runs,
    inputTokens: row.inputTokens ?? 0,
    outputTokens: row.outputTokens ?? 0,
    cacheRead: row.cacheRead ?? 0,
    cacheCreate: row.cacheCreate ?? 0,
    estCost: row.estCost ?? 0,
  }));
  const totalCostUsd = breakdown.reduce((sum, row) => sum + row.estCost, 0);

  return NextResponse.json({
    since: new Date(sinceMs).toISOString(),
    totalCostUsd,
    breakdown,
  });
}
