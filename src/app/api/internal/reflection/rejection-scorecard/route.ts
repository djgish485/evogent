import { NextResponse } from 'next/server';
import { getRejectionScorecard, normalizeReflectionHours } from '@/lib/reflection-insights';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const hoursQueried = normalizeReflectionHours(searchParams.get('hours'));

  try {
    return NextResponse.json(await getRejectionScorecard(hoursQueried));
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'failed to read rejection scorecard',
    }, { status: 500 });
  }
}
