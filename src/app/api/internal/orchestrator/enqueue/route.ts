import { NextResponse } from 'next/server';
import { fetchInternal } from '@/lib/internal-request-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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

  const response = await fetchInternal(`${getInternalBaseUrl()}/api/orchestrator/enqueue`, {
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
