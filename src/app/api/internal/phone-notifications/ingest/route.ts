import { NextResponse } from 'next/server';

import {
  ingestAndNotifyPhoneNotification,
  parsePhoneNotificationIngestInput,
} from '@/lib/phone-notification-curation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON payload' }, { status: 400 });
  }

  try {
    const input = parsePhoneNotificationIngestInput(payload);
    const result = await ingestAndNotifyPhoneNotification(input);
    return NextResponse.json({
      ok: result.ok,
      receipt: result.receipt,
      policy: result.policy,
      digest: result.digest,
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : 'Notification ingestion failed',
    }, { status: 400 });
  }
}
