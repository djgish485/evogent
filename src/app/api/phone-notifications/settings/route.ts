import { NextResponse } from 'next/server';

import {
  getPhoneNotificationSettingsView,
  updatePhoneNotificationSettings,
} from '@/lib/phone-notification-curation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(await getPhoneNotificationSettingsView());
}

export async function PATCH(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
  }

  try {
    await updatePhoneNotificationSettings(payload);
    return NextResponse.json(await getPhoneNotificationSettingsView());
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Failed to update notification settings',
    }, { status: 400 });
  }
}
