import { NextResponse } from 'next/server';
import { startFeedWatcher } from '@/lib/watcher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  await startFeedWatcher();

  return NextResponse.json({
    ok: true,
    started: ['feed'],
  });
}
