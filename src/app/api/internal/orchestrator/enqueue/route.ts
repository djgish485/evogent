import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function isHiddenCurateRequest(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') {
    return false;
  }

  const message = (payload as { message?: unknown }).message;
  if (typeof message !== 'string') {
    return false;
  }

  const normalized = message.trim().toLowerCase();
  return normalized === '/curate'
    || normalized.startsWith('/curate ')
    || normalized === '/curate-latest'
    || normalized.startsWith('/curate-latest ');
}

function getInternalBaseUrl(): string {
  if (process.env.ORCHESTRATOR_INTERNAL_URL) {
    return process.env.ORCHESTRATOR_INTERNAL_URL;
  }

  const internalPort = process.env.PORT || '3001';
  return `http://127.0.0.1:${internalPort}`;
}

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON payload' }, { status: 400 });
  }

  if (isHiddenCurateRequest(payload)) {
    return NextResponse.json({
      ok: false,
      error: 'Route curation through Curator Agent chat with POST /api/chat so the run is visible.',
    }, { status: 400 });
  }

  const response = await fetch(`${getInternalBaseUrl()}/api/orchestrator/enqueue`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    cache: 'no-store',
    body: JSON.stringify(payload),
  });

  let parsed: unknown = {};
  try {
    parsed = await response.json();
  } catch {
    // Keep empty payload for non-JSON upstream responses.
  }

  return NextResponse.json(parsed, { status: response.status });
}
