import { NextResponse } from 'next/server';
import {
  getFeedItemById,
  incrementFeedItemMetricLikes,
  recordFeedItemInteraction,
} from '@/lib/db/feed';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const tweetLikeAppliedAction = 'tweet_like_applied';
const twitterLikePassthroughAction = 'twitter_like_passthrough';

function extractTweetId(sourceId: string | null): string | null {
  if (!sourceId) return null;
  const trimmed = sourceId.trim();
  return /^\d+$/.test(trimmed) ? trimmed : null;
}

function isHackerNewsSource(source: string | null | undefined): boolean {
  const normalized = source?.trim().toLowerCase().replace(/[^a-z0-9]/g, '') ?? '';
  return normalized === 'hackernews' || normalized === 'hn';
}

async function likeTweetInBrowser(tweetId: string) {
  const browserCore = await import('../../../../../../scripts/x-browser/core');
  return browserCore.likeTweet({ target: tweetId });
}

function fireAndForgetTweetLike(tweetId: string) {
  void (async () => {
    try {
      const result = await likeTweetInBrowser(tweetId);
      console.info(`[feed.like] Browser like ${result} for ${tweetId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[feed.like] Twitter like failed for ${tweetId}: ${message}`);
    }
  })();
}

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const item = getFeedItemById(id);
  if (!item) {
    return NextResponse.json({ error: 'Feed item not found' }, { status: 404 });
  }

  if (item.type !== 'tweet') {
    return NextResponse.json({ ok: true, passthrough: false, reason: 'not-a-tweet' });
  }

  if (isHackerNewsSource(item.source)) {
    return NextResponse.json({ ok: true, passthrough: false, reason: 'not-a-twitter-tweet' });
  }

  const firstAppliedLike = recordFeedItemInteraction(item.id, tweetLikeAppliedAction);
  if (firstAppliedLike) {
    incrementFeedItemMetricLikes(item.id, 1);
  }

  const tweetId = extractTweetId(item.sourceId);
  if (!tweetId) {
    return NextResponse.json({ ok: true, passthrough: false, reason: 'invalid-tweet-id' });
  }

  const firstPassthrough = recordFeedItemInteraction(item.id, twitterLikePassthroughAction);
  if (!firstPassthrough) {
    return NextResponse.json({ ok: true, passthrough: false, reason: 'already-liked' });
  }

  fireAndForgetTweetLike(tweetId);

  return NextResponse.json({ ok: true, passthrough: true });
}
