import { NextResponse } from 'next/server';
import { normalizeReflectionHours } from '@/lib/reflection-insights';
import { getSharedBrowserHealthSummary } from '@/lib/upstream-health';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const hoursQueried = normalizeReflectionHours(searchParams.get('hours'));

  try {
    return NextResponse.json(await getSharedBrowserHealthSummary(hoursQueried));
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'failed to read upstream health',
    }, { status: 500 });
  }
}
