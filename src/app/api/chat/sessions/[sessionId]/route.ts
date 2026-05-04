import { NextResponse } from 'next/server';
import {
  countChatSessions,
  deleteChatSession,
  getChatSession,
  getConversationSessionSummary,
  getConversationSessions,
  updateChatSession,
} from '@/lib/db/chat-sessions';
import { getInternalBaseUrl } from '@/lib/internal-api';
import {
  normalizeClaudeReasoningEffort,
  normalizeCodexReasoningEffort,
} from '../../../../../../lib/brain-config.js';
import type { ConversationSessionType } from '@/types/conversation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function hasOwnProperty(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function sanitizeOptionalSessionType(value: unknown): ConversationSessionType {
  if (typeof value !== 'string') return null;
  return value.trim().toLowerCase() === 'curator' ? 'curator' : null;
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await context.params;
  const normalizedSessionId = sessionId.trim();

  if (!isUuid(normalizedSessionId)) {
    return NextResponse.json({ error: 'Invalid session ID' }, { status: 400 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
  }

  const hasTitleUpdate = hasOwnProperty(payload, 'title');
  const hasColorUpdate = hasOwnProperty(payload, 'color');
  const hasWorkingDirectoryUpdate = hasOwnProperty(payload, 'workingDirectory');
  const hasClaudeReasoningEffortUpdate = hasOwnProperty(payload, 'claudeReasoningEffort');
  const hasCodexReasoningEffortUpdate = hasOwnProperty(payload, 'codexReasoningEffort');
  const hasCodexFastModeUpdate = hasOwnProperty(payload, 'codexFastMode');
  const hasSessionTypeUpdate = hasOwnProperty(payload, 'sessionType');

  if (!hasTitleUpdate && !hasColorUpdate && !hasWorkingDirectoryUpdate && !hasClaudeReasoningEffortUpdate && !hasCodexReasoningEffortUpdate && !hasCodexFastModeUpdate && !hasSessionTypeUpdate) {
    return NextResponse.json({ error: 'At least one session field is required' }, { status: 400 });
  }

  const rawTitle = (payload as { title?: unknown }).title;
  const rawColor = (payload as { color?: unknown }).color;
  const rawWorkingDirectory = (payload as { workingDirectory?: unknown }).workingDirectory;
  const rawClaudeReasoningEffort = (payload as { claudeReasoningEffort?: unknown }).claudeReasoningEffort;
  const rawCodexReasoningEffort = (payload as { codexReasoningEffort?: unknown }).codexReasoningEffort;
  const rawCodexFastMode = (payload as { codexFastMode?: unknown }).codexFastMode;
  const rawSessionType = (payload as { sessionType?: unknown }).sessionType;

  if (hasTitleUpdate && rawTitle != null && typeof rawTitle !== 'string') {
    return NextResponse.json({ error: 'title must be a string when provided' }, { status: 400 });
  }
  if (hasColorUpdate && rawColor != null && typeof rawColor !== 'string') {
    return NextResponse.json({ error: 'color must be a string when provided' }, { status: 400 });
  }
  if (hasWorkingDirectoryUpdate && rawWorkingDirectory != null && typeof rawWorkingDirectory !== 'string') {
    return NextResponse.json({ error: 'workingDirectory must be a string when provided' }, { status: 400 });
  }
  if (hasClaudeReasoningEffortUpdate && (typeof rawClaudeReasoningEffort !== 'string' || !rawClaudeReasoningEffort.trim())) {
    return NextResponse.json({ error: 'claudeReasoningEffort must be a non-empty string when provided' }, { status: 400 });
  }
  if (hasCodexReasoningEffortUpdate && (typeof rawCodexReasoningEffort !== 'string' || !rawCodexReasoningEffort.trim())) {
    return NextResponse.json({ error: 'codexReasoningEffort must be a non-empty string when provided' }, { status: 400 });
  }
  if (hasCodexFastModeUpdate && typeof rawCodexFastMode !== 'boolean') {
    return NextResponse.json({ error: 'codexFastMode must be a boolean when provided' }, { status: 400 });
  }
  if (hasSessionTypeUpdate && rawSessionType != null && typeof rawSessionType !== 'string') {
    return NextResponse.json({ error: 'sessionType must be a string when provided' }, { status: 400 });
  }

  if (!getChatSession(normalizedSessionId)) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  const updatedSession = updateChatSession({
    sessionId: normalizedSessionId,
    title: typeof rawTitle === 'string' ? rawTitle : null,
    color: typeof rawColor === 'string' ? rawColor : null,
    workingDirectory: typeof rawWorkingDirectory === 'string' ? rawWorkingDirectory : null,
    sessionType: sanitizeOptionalSessionType(rawSessionType),
    claudeReasoningEffort: typeof rawClaudeReasoningEffort === 'string'
      ? normalizeClaudeReasoningEffort(rawClaudeReasoningEffort)
      : null,
    codexReasoningEffort: typeof rawCodexReasoningEffort === 'string'
      ? normalizeCodexReasoningEffort(rawCodexReasoningEffort)
      : null,
    codexFastMode: rawCodexFastMode === true,
    updateTitle: hasTitleUpdate,
    updateColor: hasColorUpdate,
    updateSessionType: hasSessionTypeUpdate,
    updateWorkingDirectory: hasWorkingDirectoryUpdate,
    updateClaudeReasoningEffort: hasClaudeReasoningEffortUpdate,
    updateCodexReasoningEffort: hasCodexReasoningEffortUpdate,
    updateCodexFastMode: hasCodexFastModeUpdate,
  });
  const session = getConversationSessionSummary(normalizedSessionId);
  if (!updatedSession || !session) {
    return NextResponse.json({ error: 'Failed to update session' }, { status: 500 });
  }

  const response = await fetch(`${getInternalBaseUrl()}/api/internal/chat-session-broadcast`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({
      type: 'chat_session_updated',
      sessionId: normalizedSessionId,
    }),
  });

  if (!response.ok) {
    return NextResponse.json({ error: 'Failed to broadcast chat session update' }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    session,
    sessions: getConversationSessions(),
  });
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await context.params;
  const normalizedSessionId = sessionId.trim();

  if (!isUuid(normalizedSessionId)) {
    return NextResponse.json({ error: 'Invalid session ID' }, { status: 400 });
  }

  if (!getChatSession(normalizedSessionId)) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  if (countChatSessions() <= 1) {
    return NextResponse.json({ error: 'Cannot delete the last remaining session' }, { status: 409 });
  }

  if (!deleteChatSession(normalizedSessionId)) {
    return NextResponse.json({ error: 'Failed to delete session' }, { status: 500 });
  }

  const sessions = getConversationSessions();
  const nextSessionId = sessions[0]?.sessionId ?? null;
  const response = await fetch(`${getInternalBaseUrl()}/api/internal/chat-session-broadcast`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({
      type: 'chat_session_deleted',
      sessionId: normalizedSessionId,
      nextSessionId,
    }),
  });

  if (!response.ok) {
    return NextResponse.json({ error: 'Failed to broadcast chat session deletion' }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    sessionId: normalizedSessionId,
    nextSessionId,
    sessions,
  });
}
