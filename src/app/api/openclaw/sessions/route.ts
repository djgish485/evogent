import { NextResponse } from 'next/server';
import { listOpenClawSessions } from '@/lib/openclaw/sessions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const result = await listOpenClawSessions();
  return NextResponse.json(result, { status: result.reachable ? 200 : 503 });
}
