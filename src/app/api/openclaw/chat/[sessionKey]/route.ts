import { NextResponse } from 'next/server';
import {
  getOpenClawHistory,
  sendOpenClawMessage,
} from '@/lib/openclaw/sessions';
import { normalizeGatewayErrorMessage } from '@/lib/openclaw/gateway-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function decodeSessionKey(value: string): string {
  try {
    return decodeURIComponent(value).trim();
  } catch {
    return value.trim();
  }
}

function sanitizeMessage(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ sessionKey: string }> },
) {
  const { sessionKey } = await context.params;
  const key = decodeSessionKey(sessionKey);
  if (!key) {
    return NextResponse.json({ ok: false, error: 'OpenClaw session key is required' }, { status: 400 });
  }

  try {
    const history = await getOpenClawHistory(key);
    return NextResponse.json({
      ok: true,
      ...history,
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: normalizeGatewayErrorMessage(error),
      sessionKey: key,
      messages: [],
    }, { status: 503 });
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ sessionKey: string }> },
) {
  const { sessionKey } = await context.params;
  const key = decodeSessionKey(sessionKey);
  if (!key) {
    return NextResponse.json({ ok: false, error: 'OpenClaw session key is required' }, { status: 400 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON payload' }, { status: 400 });
  }

  const message = sanitizeMessage((payload as { message?: unknown }).message);
  if (!message) {
    return NextResponse.json({ ok: false, error: 'message must be a non-empty string' }, { status: 400 });
  }

  try {
    const result = await sendOpenClawMessage(key, message);
    return NextResponse.json(result, { status: 202 });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: normalizeGatewayErrorMessage(error),
      sessionKey: key,
    }, { status: 503 });
  }
}
