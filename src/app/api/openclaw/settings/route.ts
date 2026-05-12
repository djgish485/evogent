import { NextResponse } from 'next/server';
import {
  getOpenClawSettingsView,
  updateOpenClawSettings,
} from '@/lib/openclaw/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function sanitizeOptionalText(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    settings: getOpenClawSettingsView(),
  });
}

export async function PATCH(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON payload' }, { status: 400 });
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return NextResponse.json({ ok: false, error: 'Invalid JSON payload' }, { status: 400 });
  }

  const updates: {
    gatewayUrl?: string;
    token?: string;
    defaultSessionKey?: string;
  } = {};

  if (Object.prototype.hasOwnProperty.call(payload, 'gatewayUrl')) {
    updates.gatewayUrl = sanitizeOptionalText((payload as { gatewayUrl?: unknown }).gatewayUrl);
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'token')) {
    updates.token = sanitizeOptionalText((payload as { token?: unknown }).token);
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'defaultSessionKey')) {
    updates.defaultSessionKey = sanitizeOptionalText((payload as { defaultSessionKey?: unknown }).defaultSessionKey);
  }

  try {
    const settings = updateOpenClawSettings(updates);
    return NextResponse.json({
      ok: true,
      settings: {
        gatewayUrl: settings.gatewayUrl,
        tokenConfigured: Boolean(settings.token),
        defaultSessionKey: settings.defaultSessionKey,
      },
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to save OpenClaw settings',
    }, { status: 500 });
  }
}
