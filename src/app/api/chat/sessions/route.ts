import { NextResponse } from 'next/server';
import {
  createChatSession,
  getConversationSessionPage,
  getConversationSessionSummary,
  getConversationSessions,
} from '@/lib/db/chat-sessions';
import { getDb } from '@/lib/db/client';
import { getInternalBaseUrl } from '@/lib/internal-api';
import type { ConversationSessionType } from '@/types/conversation';
import {
  normalizeBrainProvider,
  normalizeClaudeReasoningEffort,
  normalizeCodexReasoningEffort,
} from '../../../../../lib/brain-config.js';
import { backfillCodexSessionContextMetrics } from '../../../../../lib/codex-session-log-metrics.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CODEX_CONTEXT_BACKFILL_LIMITS = Object.freeze({
  maxSessions: 4,
  maxFiles: 40,
  maxFileBytes: 2 * 1024 * 1024,
  maxScanBytes: 32 * 1024 * 1024,
  maxSessionAgeMs: 7 * 24 * 60 * 60 * 1000,
  maxBroadLogSearches: 2,
});

let codexContextMetricsBackfillScheduled = false;

function scheduleCodexContextMetricsBackfillOnce(): void {
  if (codexContextMetricsBackfillScheduled) {
    return;
  }

  codexContextMetricsBackfillScheduled = true;
  setTimeout(() => {
    try {
      backfillCodexSessionContextMetrics(getDb(), CODEX_CONTEXT_BACKFILL_LIMITS);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[chat-sessions] Codex context metrics backfill skipped: ${message}`);
    }
  }, 0);
}

function sanitizeOptionalTitle(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function sanitizeOptionalText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function sanitizeOptionalSessionType(value: unknown): ConversationSessionType {
  if (typeof value !== 'string') return null;
  return value.trim().toLowerCase() === 'curator' ? 'curator' : null;
}

export async function GET(request: Request) {
  scheduleCodexContextMetricsBackfillOnce();

  const { searchParams } = new URL(request.url);
  const sessionId = sanitizeOptionalText(searchParams.get('sessionId'));

  if (sessionId) {
    const session = getConversationSessionSummary(sessionId);
    return NextResponse.json({
      ok: true,
      session,
    });
  }

  const limitRaw = searchParams.get('limit');
  const offsetRaw = searchParams.get('offset');
  const parsedLimit = limitRaw ? Number(limitRaw) : 24;
  const parsedOffset = offsetRaw ? Number(offsetRaw) : 0;
  const page = getConversationSessionPage({
    limit: Number.isFinite(parsedLimit) ? parsedLimit : 24,
    offset: Number.isFinite(parsedOffset) ? parsedOffset : 0,
  });

  return NextResponse.json({
    ok: true,
    ...page,
  });
}

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
  }

  const rawTitle = (payload as { title?: unknown }).title;
  const rawColor = (payload as { color?: unknown }).color;
  const rawWorkingDirectory = (payload as { workingDirectory?: unknown }).workingDirectory;
  const rawProvider = (payload as { provider?: unknown }).provider;
  const rawClaudeReasoningEffort = (payload as { claudeReasoningEffort?: unknown }).claudeReasoningEffort;
  const rawCodexReasoningEffort = (payload as { codexReasoningEffort?: unknown }).codexReasoningEffort;
  const rawCodexFastMode = (payload as { codexFastMode?: unknown }).codexFastMode;
  const rawSessionType = (payload as { sessionType?: unknown }).sessionType;
  if (rawTitle != null && typeof rawTitle !== 'string') {
    return NextResponse.json({ error: 'title must be a string when provided' }, { status: 400 });
  }
  if (rawColor != null && typeof rawColor !== 'string') {
    return NextResponse.json({ error: 'color must be a string when provided' }, { status: 400 });
  }
  if (rawWorkingDirectory != null && typeof rawWorkingDirectory !== 'string') {
    return NextResponse.json({ error: 'workingDirectory must be a string when provided' }, { status: 400 });
  }
  if (rawProvider != null && typeof rawProvider !== 'string') {
    return NextResponse.json({ error: 'provider must be a string when provided' }, { status: 400 });
  }
  if (rawClaudeReasoningEffort != null && typeof rawClaudeReasoningEffort !== 'string') {
    return NextResponse.json({ error: 'claudeReasoningEffort must be a string when provided' }, { status: 400 });
  }
  if (rawCodexReasoningEffort != null && typeof rawCodexReasoningEffort !== 'string') {
    return NextResponse.json({ error: 'codexReasoningEffort must be a string when provided' }, { status: 400 });
  }
  if (rawCodexFastMode != null && typeof rawCodexFastMode !== 'boolean') {
    return NextResponse.json({ error: 'codexFastMode must be a boolean when provided' }, { status: 400 });
  }
  if (rawSessionType != null && typeof rawSessionType !== 'string') {
    return NextResponse.json({ error: 'sessionType must be a string when provided' }, { status: 400 });
  }

  const provider = typeof rawProvider === 'string' && rawProvider.trim()
    ? normalizeBrainProvider(rawProvider)
    : null;
  const claudeReasoningEffort = typeof rawClaudeReasoningEffort === 'string' && rawClaudeReasoningEffort.trim()
    ? normalizeClaudeReasoningEffort(rawClaudeReasoningEffort)
    : null;
  const codexReasoningEffort = typeof rawCodexReasoningEffort === 'string' && rawCodexReasoningEffort.trim()
    ? normalizeCodexReasoningEffort(rawCodexReasoningEffort)
    : null;

  const session = createChatSession({
    provider,
    claudeReasoningEffort,
    codexReasoningEffort,
    codexFastMode: rawCodexFastMode === true,
    sessionType: sanitizeOptionalSessionType(rawSessionType),
    title: sanitizeOptionalTitle(rawTitle),
    color: sanitizeOptionalText(rawColor),
    workingDirectory: sanitizeOptionalText(rawWorkingDirectory),
  });

  try {
    const response = await fetch(`${getInternalBaseUrl()}/api/internal/chat-session-broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({
        type: 'chat_session_created',
        sessionId: session.id,
      }),
    });

    if (!response.ok) {
      console.warn(`[chat-sessions] Failed to broadcast chat session creation: ${response.status} ${response.statusText}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[chat-sessions] Failed to broadcast chat session creation: ${message}`);
  }

  return NextResponse.json({
    ok: true,
    session,
    sessions: getConversationSessions(),
  }, { status: 201 });
}
