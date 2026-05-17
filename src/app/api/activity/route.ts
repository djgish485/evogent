import { NextResponse } from 'next/server';
import { insertUserActivity, isActivityEvent } from '@/lib/db/activity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
  }

  const event = (payload as { event?: unknown }).event;
  if (!isActivityEvent(event)) {
    return NextResponse.json({
      error: 'event must be one of: app_open, pull_refresh, ping, foreground, background',
    }, { status: 400 });
  }

  const metadataRaw = (payload as { metadata?: unknown }).metadata;
  const metadata = metadataRaw && typeof metadataRaw === 'object' && !Array.isArray(metadataRaw)
    ? metadataRaw as Record<string, unknown>
    : null;

  const timestamp = new Date().toISOString();
  const activityId = insertUserActivity(event, metadata, timestamp);

  return NextResponse.json({
    ok: true,
    logged: true,
    activityId,
    heartbeat: {
      triggered: false,
      triggerReason: 'openclaw_curator_managed',
      decisionReason: 'openclaw_curator_managed',
      requestId: null,
    },
  });
}
