import { NextResponse } from 'next/server';
import { listOpenClawSessions } from '@/lib/openclaw/sessions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const includeSessionKey = searchParams.get('includeSessionKey')?.trim() || null;
  const result = await listOpenClawSessions({ includeSessionKey });
  return NextResponse.json(result, { status: result.reachable ? 200 : 503 });
}
