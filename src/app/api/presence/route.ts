import { NextResponse } from 'next/server';
import {
  isAppPresenceState,
  normalizeAppPresenceGenerationId,
  normalizeAppPresenceSequence,
  recordAppPresence,
} from '@/lib/db/presence';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return NextResponse.json({ error: 'Presence payload must be an object' }, { status: 400 });
  }

  const record = payload as Record<string, unknown>;
  const state = record.state;
  if (!isAppPresenceState(state)) {
    return NextResponse.json({
      error: 'state must be one of: foreground, background',
    }, { status: 400 });
  }

  const generationId = normalizeAppPresenceGenerationId(record.generationId);
  if (!generationId) {
    return NextResponse.json({
      error: 'generationId must be a lowercase random UUID',
    }, { status: 400 });
  }

  const sequence = normalizeAppPresenceSequence(record.sequence);
  if (sequence === null) {
    return NextResponse.json({
      error: 'sequence must be a positive safe integer',
    }, { status: 400 });
  }

  return NextResponse.json({
    ok: true,
    updated: recordAppPresence(state, generationId, sequence),
  });
}
