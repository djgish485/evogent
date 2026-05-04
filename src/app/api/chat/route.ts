import fs from 'node:fs';
import { NextResponse } from 'next/server';
import {
  createChatSession,
  getChatSession,
  getMostRecentChatSessionForProvider,
} from '@/lib/db/chat-sessions';
import { submitChatMessage } from '@/lib/chat-submission';
import { getChatAttachmentsDir, parseChatAttachments } from '@/lib/chat-attachments';
import { getProviderReadiness } from '@/lib/setup-readiness';
import type { ChatAttachment } from '@/types/chat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type ChatContextKind = 'global' | 'post';
type ChatOriginView = 'feed' | 'post_detail' | 'feed/setup_card' | 'feed/source_health_button';

function sanitizeOptionalText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function sanitizeOptionalMetadata(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  try {
    const normalized = JSON.parse(JSON.stringify(value));
    if (normalized && typeof normalized === 'object' && !Array.isArray(normalized)) {
      return normalized as Record<string, unknown>;
    }
  } catch {
    return null;
  }

  return null;
}

function normalizeContextKind(value: unknown): ChatContextKind {
  return value === 'post' ? 'post' : 'global';
}

function normalizeOriginView(value: unknown): ChatOriginView {
  if (value === 'feed/setup_card') return 'feed/setup_card';
  if (value === 'feed/source_health_button') return 'feed/source_health_button';
  return value === 'post_detail' ? 'post_detail' : 'feed';
}

async function resolveTargetSessionId(
  selectedSessionId: string | null,
  provider: 'claude' | 'codex',
): Promise<string> {
  const trimmedSessionId = selectedSessionId?.trim();
  if (trimmedSessionId) {
    const existing = getChatSession(trimmedSessionId);
    if (existing) {
      return existing.id;
    }
  }

  const latest = getMostRecentChatSessionForProvider(provider);
  if (latest) {
    return latest.id;
  }

  return createChatSession({ provider }).id;
}

async function resolveExistingAttachments(payload: unknown): Promise<ChatAttachment[]> {
  const attachments = parseChatAttachments(payload);
  if (attachments.length === 0) return [];

  const existing = await Promise.all(attachments.map(async (attachment) => {
    try {
      await fs.promises.stat(attachment.filePath);
      return attachment;
    } catch {
      return null;
    }
  }));

  return existing.filter((attachment): attachment is ChatAttachment => attachment !== null);
}

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
  }

  const message = sanitizeOptionalText((payload as { message?: unknown }).message) || '';
  const context = sanitizeOptionalText((payload as { context?: unknown }).context);
  const inReplyTo = sanitizeOptionalText((payload as { inReplyTo?: unknown }).inReplyTo);
  const selectedSessionId = sanitizeOptionalText((payload as { sessionId?: unknown }).sessionId);
  const contextKind = normalizeContextKind((payload as { contextKind?: unknown }).contextKind);
  const contextRefId = sanitizeOptionalText((payload as { contextRefId?: unknown }).contextRefId);
  const originView = normalizeOriginView((payload as { originView?: unknown }).originView);
  const requestMetadata = sanitizeOptionalMetadata((payload as { metadata?: unknown }).metadata);
  const attachments = await resolveExistingAttachments((payload as { attachments?: unknown }).attachments);

  if (!message) {
    return NextResponse.json({ error: 'message must be a non-empty string' }, { status: 400 });
  }

  await fs.promises.mkdir(getChatAttachmentsDir(), { recursive: true });
  const providerReadiness = await getProviderReadiness();
  if (!providerReadiness.selected) {
    return NextResponse.json({
      ok: false,
      enqueued: false,
      queueDepth: 0,
      requestId: null,
      message: providerReadiness.message,
      error: providerReadiness.message,
      provider: providerReadiness,
    }, { status: 409 });
  }

  const currentProvider = providerReadiness.selected;
  const sessionId = await resolveTargetSessionId(selectedSessionId, currentProvider);

  let result;
  try {
    result = await submitChatMessage({
      message,
      sessionId,
      context,
      inReplyTo,
      contextKind,
      contextRefId,
      originView,
      metadata: requestMetadata,
      attachments,
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      enqueued: false,
      queueDepth: 0,
      requestId: null,
      message: error instanceof Error ? error.message : 'Failed to queue message for evogent orchestrator',
    }, { status: 503 });
  }

  return NextResponse.json({
    ok: result.ok,
    enqueued: result.ok,
    requestId: result.requestId,
    queueDepth: result.queueDepth,
    message: result.message,
    userMessage: result.userMessage,
    sessionId: result.sessionId,
  }, { status: result.ok ? 202 : 503 });
}
