import { NextResponse } from 'next/server';

import { removeAndNotifyPhoneNotification } from '@/lib/phone-notification-curation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Content-free lifecycle callback from the native listener.
 *
 * The event digest was minted before loopback transport and binds the exact Android revision.
 * Persisting it even when ingest has not landed yet prevents that racing ingest from resurrecting
 * an event Android already removed.
 */
export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON payload' }, { status: 400 });
  }
  const body = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
  try {
    const result = await removeAndNotifyPhoneNotification(body.eventId);
    return NextResponse.json({
      ok: result.ok,
      eventId: result.eventId,
      resolved: result.resolved,
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : 'Notification removal failed',
    }, { status: 400 });
  }
}
