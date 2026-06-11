import { NextResponse } from 'next/server';
import {
  defaultCarryForwardLimit,
  defaultCarryForwardWindowHours,
  defaultCarryForwardReviewLimit,
  listFeedCarryForwardCandidates,
  maxCarryForwardLimit,
  maxCarryForwardReviewLimit,
  maxCarryForwardWindowHours,
  normalizeCarryForwardBoundedInt,
} from '@/lib/feed-carry-forward';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function readBooleanFlag(value: string | null, fallback: boolean): boolean {
  if (value === null) return fallback;
  const normalized = value.trim().toLowerCase();
  if (['false', '0', 'no'].includes(normalized)) return false;
  if (['true', '1', 'yes'].includes(normalized)) return true;
  return fallback;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const windowHours = normalizeCarryForwardBoundedInt(
    searchParams.get('hours'),
    defaultCarryForwardWindowHours,
    maxCarryForwardWindowHours,
  );
  const limit = normalizeCarryForwardBoundedInt(
    searchParams.get('limit'),
    defaultCarryForwardLimit,
    maxCarryForwardLimit,
  );
  const reviewLimit = normalizeCarryForwardBoundedInt(
    searchParams.get('reviewLimit'),
    defaultCarryForwardReviewLimit,
    maxCarryForwardReviewLimit,
  );
  const includeAllUnviewed = readBooleanFlag(
    searchParams.get('includeAllUnviewed') ?? searchParams.get('all'),
    true,
  );
  const includeDisplayed = readBooleanFlag(
    searchParams.get('includeDisplayed') ?? searchParams.get('displayed'),
    true,
  );
  const candidates = listFeedCarryForwardCandidates({
    windowHours,
    limit,
    reviewLimit,
    includeAllUnviewed,
    includeDisplayed,
  });

  return NextResponse.json({
    ok: true,
    queriedWindowHours: includeAllUnviewed ? null : windowHours,
    count: candidates.length,
    review: candidates.review,
    candidates,
  });
}
