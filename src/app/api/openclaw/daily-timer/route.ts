import { NextResponse } from 'next/server';
import { getOpenClawDailyTimerStatus, repairOpenClawDailyTimer } from '@/lib/openclaw-daily-timer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return NextResponse.json({
      ok: true,
      timer: getOpenClawDailyTimerStatus(),
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to inspect OpenClaw daily timer',
    }, { status: 500 });
  }
}

export async function POST() {
  try {
    const timer = repairOpenClawDailyTimer();
    return NextResponse.json({
      ok: true,
      timer,
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to repair OpenClaw daily timer',
    }, { status: 409 });
  }
}
