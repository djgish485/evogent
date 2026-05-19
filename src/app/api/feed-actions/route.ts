import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getSkillAction } from '@/lib/feed-actions/skill-action-registry';
import { getInternalBaseUrl } from '@/lib/internal-api';

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

  const response = await fetch(`${getInternalBaseUrl()}/api/openclaw/chat/${encodeURIComponent(sessionKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({
      message,
      idempotencyKey,
    }),
  });

  const result = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || result.ok === false) {
    return NextResponse.json({
      ok: false,
      error: typeof result.error === 'string' && result.error.trim()
        ? result.error
        : `OpenClaw action dispatch failed (${response.status})`,
      actionId,
      feedItemId,
      sessionKey,
    }, { status: response.status || 502 });
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
    sessionId: typeof result.sessionId === 'string' ? result.sessionId : `openclaw:${sessionKey}`,
    runId: typeof result.runId === 'string' ? result.runId : idempotencyKey,
  }, { status: 202 });
}
