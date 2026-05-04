import { NextResponse } from 'next/server';
import { deletePreferenceById, updatePreferenceReason } from '@/lib/db/preferences';
import { regeneratePreferenceContext } from '@/lib/preferences-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function tryRegeneratePreferenceContext(): Promise<void> {
  try {
    await regeneratePreferenceContext();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[preferences] Failed to regenerate preference context: ${message}`);
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const preferenceId = typeof id === 'string' ? id.trim() : '';

  if (!preferenceId) {
    return NextResponse.json({ error: 'Preference id is required' }, { status: 400 });
  }

  const removed = deletePreferenceById(preferenceId);
  if (!removed) {
    return NextResponse.json({ error: 'Preference not found' }, { status: 404 });
  }

  await tryRegeneratePreferenceContext();

  return NextResponse.json({
    ok: true,
    removed,
  });
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const preferenceId = typeof id === 'string' ? id.trim() : '';

  if (!preferenceId) {
    return NextResponse.json({ error: 'Preference id is required' }, { status: 400 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!payload || typeof payload !== 'object') {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
  }

  const reason = (payload as Record<string, unknown>).reason;
  if (typeof reason !== 'string') {
    return NextResponse.json({ error: 'reason must be a string' }, { status: 400 });
  }

  const updated = updatePreferenceReason(preferenceId, reason);
  if (!updated) {
    return NextResponse.json({ error: 'Preference not found' }, { status: 404 });
  }

  await tryRegeneratePreferenceContext();

  return NextResponse.json({
    ok: true,
    item: updated,
  });
}
