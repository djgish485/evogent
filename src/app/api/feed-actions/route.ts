import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getSkillAction } from '@/lib/feed-actions/skill-action-registry';
import { submitChatMessage } from '@/lib/chat-submission';
import { getMostRecentCuratorChatSession } from '@/lib/db/chat-sessions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readRequiredString(record: Record<string, unknown>, key: string): string {
  return typeof record[key] === 'string' && record[key].trim() ? record[key].trim() : '';
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON payload' }, { status: 400 });
  }

  const record = isRecord(body) ? body : {};
  const actionId = readRequiredString(record, 'actionId').toLowerCase();
  const feedItemId = readRequiredString(record, 'feedItemId') || readRequiredString(record, 'itemId');
  const payload = isRecord(record.payload) ? record.payload : {};

  if (!actionId || !feedItemId) {
    return NextResponse.json({ ok: false, error: 'actionId and feedItemId are required' }, { status: 400 });
  }

  const skillAction = getSkillAction(actionId);
  if (!skillAction) {
    return NextResponse.json({ ok: false, error: `No installed skill declares feed action "${actionId}"` }, { status: 400 });
  }

  const sessionKey = `agent:${skillAction.skill}:main`;
  const idempotencyKey = `feed-action-${randomUUID()}`;
  const message = [
    `Action: ${skillAction.skill}.${skillAction.action.id} on feed item ${feedItemId}`,
    `Label: ${skillAction.action.label}`,
    `Payload JSON: ${JSON.stringify(payload)}`,
    `Declared in: ${skillAction.skillPath}`,
    'Handle this according to the feed-actions instructions in the installed skill. Do not use product-side custom dispatch logic.',
  ].join('\n');

  // Dispatch directly into the Curator Agent chat session (the same path a
  // user typing into chat takes) rather than a separate agent-per-skill
  // session; sessionKey is retained below only as a caller-facing label.
  const curatorSession = getMostRecentCuratorChatSession();
  const dispatchSessionId = curatorSession?.id || sessionKey;

  let result: Awaited<ReturnType<typeof submitChatMessage>>;
  try {
    result = await submitChatMessage({
      message,
      sessionId: dispatchSessionId,
      workingDirectory: curatorSession?.workingDirectory ?? null,
      priority: 'user_chat',
      source: 'feed_action',
      requestId: idempotencyKey,
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error && error.message.trim()
        ? error.message.trim()
        : 'Feed action dispatch failed',
      actionId,
      feedItemId,
      sessionKey,
    }, { status: 502 });
  }

  if (!result.ok) {
    return NextResponse.json({
      ok: false,
      error: result.message || 'Feed action dispatch failed',
      actionId,
      feedItemId,
      sessionKey,
    }, { status: 502 });
  }

  return NextResponse.json({
    ok: true,
    optimistic: {
      status: 'dispatched',
      label: skillAction.action.label,
    },
    actionId,
    feedItemId,
    sessionKey,
    sessionId: result.sessionId,
    runId: idempotencyKey,
  }, { status: 202 });
}
