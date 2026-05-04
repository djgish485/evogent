import { NextResponse } from 'next/server';
import { getFirstRunReadiness } from '@/lib/setup-readiness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const readiness = await getFirstRunReadiness();
  return NextResponse.json({
    checkedAt: readiness.checkedAt,
    setupReady: readiness.required.length === 0,
    required: readiness.required,
    pending: readiness.pending,
    ready: readiness.ready,
    sources: readiness.sources,
  });
}
