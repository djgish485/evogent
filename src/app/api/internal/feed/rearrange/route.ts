import { NextResponse } from 'next/server';
import { getCurrentFeedArrangeInput } from '@/lib/db/feed';
import { POST as arrangePost } from '@/app/api/internal/curate/arrange/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Refresh the CURRENT feed without inventing a new editorial ranking. The backstop reconstructs
// the prior explicit shipment order, retains the complete structurally eligible unseen set up to
// the content ceiling, and refreshes deterministic suggestion lanes. Value/freshness decisions
// remain the runtime agent's; this route never re-ranks by age, taste, source, type, or popularity.
// Safe to call anytime; a no-op when nothing is displayed yet.
export async function POST(request: Request) {
  const { ordering, threads } = getCurrentFeedArrangeInput();
  if (ordering.length === 0) {
    return NextResponse.json({ ok: true, rearranged: false, reason: 'no_displayed_items', orderingCount: 0 });
  }

  const arrangeRequest = new Request(new URL(request.url).origin + '/api/internal/curate/arrange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ordering, threads }),
  });
  const result = await arrangePost(arrangeRequest);
  const payload = await result.json() as Record<string, unknown>;
  return NextResponse.json({ ...payload, rearranged: result.ok, reconstructedFromCurrentFeed: true }, { status: result.status });
}
