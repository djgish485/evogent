import { NextResponse } from 'next/server';
import { completeAdaptiveHeartbeat } from '@/lib/heartbeat-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
  }

  const requestId = typeof (payload as { requestId?: unknown }).requestId === 'string'
    ? (payload as { requestId: string }).requestId.trim()
    : '';
  const completionStatus = typeof (payload as { completionStatus?: unknown }).completionStatus === 'string'
    ? (payload as { completionStatus: string }).completionStatus.trim()
    : null;
  const completionReason = typeof (payload as { completionReason?: unknown }).completionReason === 'string'
    ? (payload as { completionReason: string }).completionReason.trim()
    : null;

  if (!requestId) {
    return NextResponse.json({ error: 'requestId is required' }, { status: 400 });
  }

  const completed = completeAdaptiveHeartbeat(requestId, {
    completionStatus: completionStatus === 'successful_empty' ? 'successful_empty' : null,
    completionReason,
  });

  return NextResponse.json({
    ok: true,
    completed,
    requestId,
    completedAt: new Date().toISOString(),
  });
}
