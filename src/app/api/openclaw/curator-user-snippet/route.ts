import { NextResponse } from 'next/server';
import { getCuratorUserSnippet } from '@/lib/openclaw/curator-user-snippet';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON payload' }, { status: 400 });
  }

  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  return NextResponse.json({
    ok: true,
    snippet: getCuratorUserSnippet(input),
  });
}
