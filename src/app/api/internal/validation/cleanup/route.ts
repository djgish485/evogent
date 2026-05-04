import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { deleteValidationFixtures } from '@/lib/db/validation-fixtures';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
  }

  const record = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null;

  if (!record) {
    return NextResponse.json({ error: 'Request body must be a JSON object' }, { status: 400 });
  }

  const result = deleteValidationFixtures(getDb(), {
    ids: normalizeStringArray(record.ids),
    sourceIds: normalizeStringArray(record.sourceIds),
    originSessionIds: normalizeStringArray(record.originSessionIds),
  });

  return NextResponse.json({
    ok: true,
    ...result,
  });
}
