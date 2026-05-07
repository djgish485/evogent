import fs from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CODEX_SESSION_FILE_LIMIT = 20;

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

type CodexUnavailableReason = 'no_sessions_dir' | 'no_rate_limits' | 'parse_error';
type CodexUsageWindow = {
  usedPercent: number;
  remainingPercent: number;
  windowMinutes: number | null;
  resetsAt: string | null;
};
type CodexUsageResult = {
  codex: {
    short: CodexUsageWindow;
    weekly: CodexUsageWindow;
    lastObservedAt: string;
  } | null;
  codexUnavailable?: CodexUnavailableReason;
};
type CodexSessionFile = {
  filePath: string;
  mtimeMs: number;
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

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function toFiniteNumber(value: unknown): number | null {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function formatCodexReset(value: unknown): string | null {
  const timestamp = toFiniteNumber(value);
  if (timestamp === null || timestamp <= 0) {
    return null;
  }
  const milliseconds = timestamp > 10_000_000_000 ? timestamp : timestamp * 1000;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function normalizeCodexWindow(value: unknown): CodexUsageWindow | null {
  const limitWindow = readRecord(value);
  const usedPercent = toFiniteNumber(limitWindow?.used_percent);
  if (usedPercent === null) {
    return null;
  }

  const windowMinutes = toFiniteNumber(limitWindow?.window_minutes);
  return {
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    windowMinutes: windowMinutes === null ? null : Math.max(0, Math.floor(windowMinutes)),
    resetsAt: formatCodexReset(limitWindow?.resets_at),
  };
}

function collectCodexSessionFiles(dir: string, files: CodexSessionFile[] = []): CodexSessionFile[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectCodexSessionFiles(entryPath, files);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      const stat = fs.statSync(entryPath);
      files.push({ filePath: entryPath, mtimeMs: stat.mtimeMs });
    }
  }
  return files;
}

function readCodexUsageSummary(): CodexUsageResult {
  const sessionsDir = path.join(process.env.HOME || '/root', '.codex', 'sessions');
  if (!fs.existsSync(sessionsDir)) {
    return { codex: null, codexUnavailable: 'no_sessions_dir' };
  }

  try {
    const files = collectCodexSessionFiles(sessionsDir)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, CODEX_SESSION_FILE_LIMIT);

    for (const file of files) {
      const lines = fs.readFileSync(file.filePath, 'utf8').split(/\r?\n/);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index]?.trim();
        if (!line) {
          continue;
        }

        let event: Record<string, unknown> | null = null;
        try {
          event = readRecord(JSON.parse(line));
        } catch {
          continue;
        }

        const payload = readRecord(event?.payload);
        const rateLimits = readRecord(payload?.rate_limits);
        if (payload?.type !== 'token_count' || rateLimits?.limit_id !== 'codex') {
          continue;
        }

        const short = normalizeCodexWindow(rateLimits.primary);
        const weekly = normalizeCodexWindow(rateLimits.secondary);
        if (short && weekly) {
          return {
            codex: {
              short,
              weekly,
              lastObservedAt: new Date(file.mtimeMs).toISOString(),
            },
          };
        }
      }
    }

    return { codex: null, codexUnavailable: 'no_rate_limits' };
  } catch {
    return { codex: null, codexUnavailable: 'parse_error' };
  }
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
  const codexUsage = readCodexUsageSummary();

  return NextResponse.json({
    since: new Date(sinceMs).toISOString(),
    totalCostUsd,
    breakdown,
    ...codexUsage,
  });
}
