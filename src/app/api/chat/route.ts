import fs from 'node:fs';
import { NextResponse } from 'next/server';
import {
  createChatSession,
  getChatSession,
  getOrCreateMainChatSession,
} from '@/lib/db/chat-sessions';
import { submitChatMessage } from '@/lib/chat-submission';
import { getChatAttachmentsDir, parseChatAttachments } from '@/lib/chat-attachments';
import { getProviderReadiness } from '@/lib/setup-readiness';
import {
  completeCurationLogByRequestId,
  insertCurationLogStartIfAbsent,
} from '@/lib/db/activity';
import type { ChatAttachment } from '@/types/chat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type ChatContextKind = 'global' | 'post' | 'screen';
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

function readPhoneSchedulerCycleId(metadata: Record<string, unknown> | null): string | null {
  if (metadata?.trigger !== 'phone_scheduler') return null;
  if (typeof metadata.curationCycleId !== 'string') return null;
  const cycleId = metadata.curationCycleId.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/.test(cycleId) ? cycleId : null;
}

function normalizeContextKind(value: unknown): ChatContextKind {
  if (value === 'post') return 'post';
  if (value === 'screen') return 'screen';
  return 'global';
}

function normalizeOriginView(value: unknown): ChatOriginView {
  if (value === 'feed/setup_card') return 'feed/setup_card';
  if (value === 'feed/source_health_button') return 'feed/source_health_button';
  return value === 'post_detail' ? 'post_detail' : 'feed';
}

// Friendly session titles for the overlay's "ask about this screen" sessions, keyed by the
// foreground package the accessibility service reported. Falls back to a generic label so a
// title is always meaningful in the session list. (A real per-app label from PackageManager
// would be nicer; this covers the common apps without a native round-trip.)
const OVERLAY_APP_TITLES: Record<string, string> = {
  'com.google.android.gm': 'Gmail',
  'com.google.android.youtube': 'YouTube',
  'com.google.android.apps.docs': 'Drive',
  'com.google.android.apps.nbu.files': 'Files',
  'com.google.android.apps.maps': 'Maps',
  'com.google.android.apps.messaging': 'Messages',
  'com.android.chrome': 'Chrome',
  'com.android.settings': 'Settings',
  'com.twitter.android': 'X',
  'com.reddit.frontpage': 'Reddit',
  'com.instagram.android': 'Instagram',
  'com.amazon.kindle': 'Kindle',
  'com.spotify.music': 'Spotify',
  'com.slack': 'Slack',
  'com.whatsapp': 'WhatsApp',
};

function overlaySessionTitle(screenApp: unknown): string {
  if (typeof screenApp === 'string' && screenApp.trim()) {
    const pkg = screenApp.trim();
    if (OVERLAY_APP_TITLES[pkg]) return OVERLAY_APP_TITLES[pkg];
    // Derive a rough label from the package's most specific segment (…android.gm -> "Gm").
    const segment = pkg.split('.').filter(Boolean).pop();
    if (segment && /^[a-z]/i.test(segment)) {
      return segment.charAt(0).toUpperCase() + segment.slice(1);
    }
  }
  return 'Quick question';
}

// A send without an explicit session normally targets the durable main session — never
// "whichever session was updated last" (that fall-through routed quick questions into the
// Curator thread). The overlay is the exception: `createFresh` mints a brand-new session per
// bubble-open so "ask about this screen" starts blank instead of resuming the main thread.
async function resolveTargetSessionId(
  selectedSessionId: string | null,
  provider: 'claude' | 'codex',
  opts?: { createFresh?: boolean; title?: string | null },
): Promise<string> {
  const trimmedSessionId = selectedSessionId?.trim();
  if (trimmedSessionId) {
    const existing = getChatSession(trimmedSessionId);
    if (existing) {
      return existing.id;
    }
  }

  if (opts?.createFresh) {
    return createChatSession({
      provider,
      title: opts.title ?? null,
      claudeReasoningEffort: 'low',
    }).id;
  }

  return getOrCreateMainChatSession({ provider }).id;
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
  const phoneSchedulerCycleId = readPhoneSchedulerCycleId(requestMetadata);
  const wantsFreshSession = (payload as { newSession?: unknown }).newSession === true;
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
  const sessionId = await resolveTargetSessionId(selectedSessionId, currentProvider, {
    createFresh: wantsFreshSession && !selectedSessionId,
    title: overlaySessionTitle(requestMetadata?.screenApp),
  });

  if (requestMetadata?.trigger === 'phone_scheduler' && !phoneSchedulerCycleId) {
    return NextResponse.json({
      ok: false,
      enqueued: false,
      queueDepth: 0,
      requestId: null,
      message: 'phone_scheduler requests require a valid curationCycleId',
    }, { status: 400 });
  }

  let insertedPhoneCycle = false;
  if (phoneSchedulerCycleId) {
    let inserted = false;
    try {
      // The unique cycle claim and its feed baseline are captured by one SQLite
      // statement before the task can be accepted by the orchestrator.
      inserted = insertCurationLogStartIfAbsent({
        requestId: phoneSchedulerCycleId,
        triggeredBy: 'phone_scheduler:cycle',
      });
    } catch {
      return NextResponse.json({
        ok: false,
        enqueued: false,
        queueDepth: 0,
        requestId: null,
        message: 'could not register the automated curation cycle',
      }, { status: 503 });
    }
    if (!inserted) {
      return NextResponse.json({
        ok: false,
        enqueued: false,
        queueDepth: 0,
        requestId: null,
        message: 'curationCycleId has already been used',
      }, { status: 409 });
    }
    insertedPhoneCycle = true;
  }

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
    if (insertedPhoneCycle && phoneSchedulerCycleId) {
      completeCurationLogByRequestId(phoneSchedulerCycleId, {
        itemsAdded: 0,
        completionStatus: 'failed',
        completionReason: 'curation_task_enqueue_failed',
      });
    }
    return NextResponse.json({
      ok: false,
      enqueued: false,
      queueDepth: 0,
      requestId: null,
      message: error instanceof Error ? error.message : 'Failed to queue message for evogent orchestrator',
    }, { status: 503 });
  }

  if (!result.ok && insertedPhoneCycle && phoneSchedulerCycleId) {
    completeCurationLogByRequestId(phoneSchedulerCycleId, {
      itemsAdded: 0,
      completionStatus: 'failed',
      completionReason: 'curation_task_enqueue_failed',
    });
  }

  return NextResponse.json({
    ok: result.ok,
    enqueued: result.ok,
    requestId: result.requestId,
    queueDepth: result.queueDepth,
    message: result.message,
    userMessage: result.userMessage,
    sessionId: result.sessionId,
    curationCycleId: phoneSchedulerCycleId,
  }, { status: result.ok ? 202 : 503 });
}
