import { NextResponse } from 'next/server';
import { resolveFeedItemByIdentifier } from '@/lib/db/feed';
import { queueFeedItemEnrichment } from '@/lib/feed-enrichment';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const item = resolveFeedItemByIdentifier(id);

  if (!item) {
    return NextResponse.json({ ok: false, error: 'Post not found' }, { status: 404 });
  }

  try {
    const result = await queueFeedItemEnrichment(item, {
      endpoint: '/api/feed/[id]/enrich',
      mode: 'full',
      routeId: id,
      source: 'post_enrichment',
      tracking: 'full',
      trigger: 'on_demand_enrichment',
    });

    if (!result.ok) {
      return NextResponse.json({
        ok: false,
        error: result.error ?? 'Failed to queue enrichment',
      }, { status: 503 });
    }

    return NextResponse.json({
      ok: true,
      alreadyRequested: result.alreadyRequested ?? false,
      alreadyRunning: result.alreadyRunning,
      postId: result.postId,
      requestId: result.requestId,
      requestedAt: result.requestedAt,
      queueDepth: result.queueDepth,
      agent: result.agent,
    }, { status: 202 });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to start enrichment',
    }, { status: 500 });
  }
}
