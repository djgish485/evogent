import { NextResponse } from 'next/server';
import { arrangeFeedBackstopForCycle, getActiveFeedThreads } from '@/lib/db/feed';
import { notifyFeedArranged } from '@/lib/curation-submit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let payload: unknown = {};
  try {
    payload = await request.json();
  } catch {
    payload = {};
  }

  const startedAtMsRaw = (payload as { startedAtMs?: unknown }).startedAtMs;
  const startedAtMs = typeof startedAtMsRaw === 'number' && Number.isFinite(startedAtMsRaw)
    ? startedAtMsRaw
    : null;

  if (startedAtMs === null) {
    return NextResponse.json({ ok: false, error: 'startedAtMs (number) is required' }, { status: 400 });
  }

  try {
    const result = arrangeFeedBackstopForCycle(startedAtMs);
    if (result.fired) {
      console.log('[arrange-backstop] fired via /api/internal/feed/arrange-backstop', {
        startedAtMs,
        itemCount: result.itemCount,
      });
      void notifyFeedArranged({
        ordering: [],
        activeThreads: getActiveFeedThreads(),
        updatedItemIds: [],
        orderingCount: result.itemCount,
        threadCount: 0,
      });
    }
    return NextResponse.json({
      ok: true,
      fired: result.fired,
      itemCount: result.itemCount,
      reason: result.reason,
      checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : 'arrange backstop failed',
    }, { status: 500 });
  }
}
