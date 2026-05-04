import { NextResponse } from 'next/server';
import { cancelCodeFixSuggestionWork } from '@/lib/code-fix-orchestrator';
import {
  getFeedItemById,
  getInteractionStates,
  hasFeedItemInteraction,
  setFeedItemDisliked,
  setFeedItemLiked,
  setFeedItemSuggestionStatus,
} from '@/lib/db/feed';
import { getFeedSuggestionType } from '@/lib/feed-suggestions';
import { deletePreferenceByFeedItem, insertPreference, updatePreferenceReasonByFeedItem } from '@/lib/db/preferences';
import { insertThreadFeedback, type ThreadFeedbackVote } from '@/lib/db/thread-feedback';
import { regeneratePreferenceContext } from '@/lib/preferences-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const tweetLikeAppliedAction = 'tweet_like_applied';

function isHackerNewsSource(source: string | null | undefined): boolean {
  const normalized = source?.trim().toLowerCase().replace(/[^a-z0-9]/g, '') ?? '';
  return normalized === 'hackernews' || normalized === 'hn';
}

function trimPayloadString(value: unknown): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed ? trimmed : null;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(
    value
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter(Boolean),
  ));
}

function buildThreadFeedbackPreferenceText(input: {
  threadTitle: string | null;
  threadId: string;
  vote: ThreadFeedbackVote;
  probeReason: string | null;
  probeUncertainty: string | null;
  category: string | null;
  sourceItemIds: string[];
}): string {
  const title = input.threadTitle || input.threadId;
  const direction = input.vote === 'more' ? 'more' : 'less';
  const parts = [
    `Feedback probe on thread "${title}": user asked for ${direction} like this.`,
  ];

  if (input.category) parts.push(`Category: ${input.category}.`);
  if (input.probeReason) parts.push(`Probe reason: ${input.probeReason}.`);
  if (input.probeUncertainty) parts.push(`Uncertainty: ${input.probeUncertainty}.`);
  if (input.sourceItemIds.length > 0) parts.push(`Source items: ${input.sourceItemIds.join(', ')}.`);

  return parts.join(' ');
}

async function tryRegeneratePreferenceContext(): Promise<void> {
  try {
    await regeneratePreferenceContext();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[interactions] Failed to regenerate preference context: ${message}`);
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const idsRaw = searchParams.get('ids') || '';
  const ids = idsRaw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  const states = getInteractionStates(ids);
  return NextResponse.json({ states });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const payload = body as Record<string, unknown>;
  const feedItemId = typeof payload.feedItemId === 'string' ? payload.feedItemId : '';
  const reason = typeof payload.reason === 'string' ? payload.reason.trim() : '';
  const action = typeof payload.action === 'string' ? payload.action : null;
  const supportedActions = new Set([
    'like',
    'unlike',
    'thumbsup',
    'thumbsdown',
    'undo_thumbsup',
    'undo_thumbsdown',
    'accept_suggestion',
    'dismiss_suggestion',
    'undo_suggestion',
    'thread_feedback',
  ]);

  if (!feedItemId || !action || !supportedActions.has(action)) {
    return NextResponse.json({ error: 'feedItemId and action are required' }, { status: 400 });
  }

  const item = getFeedItemById(feedItemId);
  if (!item) {
    return NextResponse.json({ error: 'Feed item not found' }, { status: 404 });
  }

  if (action === 'like' || action === 'unlike') {
    setFeedItemLiked(feedItemId, action === 'like');

    return NextResponse.json({ ok: true, liked: action === 'like' });
  }

  if (action === 'accept_suggestion' || action === 'dismiss_suggestion' || action === 'undo_suggestion') {
    if (item.type !== 'suggestion') {
      return NextResponse.json({ error: 'Suggestion actions are only valid for suggestion items' }, { status: 400 });
    }

    const suggestionStatus = action === 'accept_suggestion'
      ? 'accepted'
      : action === 'dismiss_suggestion'
        ? 'dismissed'
        : 'pending';

    if (action === 'dismiss_suggestion' && getFeedSuggestionType(item) === 'code_fix') {
      try {
        await cancelCodeFixSuggestionWork({
          suggestionId: feedItemId,
          taskId: typeof item.metadata?.taskId === 'string' ? item.metadata.taskId : null,
          suggestionStatus: 'dismissed',
          reason: 'Cancelled because the suggestion was dismissed from interactions.',
        });
      } catch (error) {
        const message = error instanceof Error && error.message.trim()
          ? error.message.trim()
          : 'Failed to cancel active code-fix task';
        return NextResponse.json({ error: message }, { status: 500 });
      }
    }

    setFeedItemSuggestionStatus(feedItemId, suggestionStatus);
    return NextResponse.json({ ok: true, suggestionStatus });
  }

  if (action === 'thread_feedback') {
    const rawThreadFeedback = payload.threadFeedback;
    if (!rawThreadFeedback || typeof rawThreadFeedback !== 'object' || Array.isArray(rawThreadFeedback)) {
      return NextResponse.json({ error: 'threadFeedback is required' }, { status: 400 });
    }

    const threadFeedback = rawThreadFeedback as Record<string, unknown>;
    const threadId = trimPayloadString(threadFeedback.threadId);
    const voteRaw = trimPayloadString(threadFeedback.vote)?.toLowerCase() ?? '';
    const vote: ThreadFeedbackVote | null = voteRaw === 'more' || voteRaw === 'up'
      ? 'more'
      : voteRaw === 'less' || voteRaw === 'down'
        ? 'less'
        : null;

    if (!threadId || !vote) {
      return NextResponse.json({ error: 'threadFeedback.threadId and vote are required' }, { status: 400 });
    }

    const sourceItemIds = normalizeStringList(threadFeedback.sourceItemIds);
    const feedbackSourceItemIds = sourceItemIds.length > 0 ? sourceItemIds : [feedItemId];
    const feedbackReason = trimPayloadString(threadFeedback.reason) ?? reason;
    const insertedFeedback = insertThreadFeedback({
      threadId,
      cycleId: trimPayloadString(threadFeedback.cycleId),
      feedItemId,
      vote,
      threadTitle: trimPayloadString(threadFeedback.threadTitle),
      reason: feedbackReason,
      category: trimPayloadString(threadFeedback.category),
      probeReason: trimPayloadString(threadFeedback.probeReason),
      probeUncertainty: trimPayloadString(threadFeedback.probeUncertainty),
      sourceItemIds: feedbackSourceItemIds,
      originSessionId: trimPayloadString(threadFeedback.originSessionId)
        ?? trimPayloadString(item.originSessionId)
        ?? trimPayloadString(item.metadata?.originSessionId),
    });

    insertPreference({
      feedItemId,
      signalType: vote === 'more' ? 'liked' : 'disliked',
      source: 'app_thread_feedback_probe',
      text: buildThreadFeedbackPreferenceText({
        threadTitle: insertedFeedback.threadTitle,
        threadId: insertedFeedback.threadId,
        vote,
        probeReason: insertedFeedback.probeReason,
        probeUncertainty: insertedFeedback.probeUncertainty,
        category: insertedFeedback.category,
        sourceItemIds: insertedFeedback.sourceItemIds,
      }),
      reason: insertedFeedback.reason ?? undefined,
      authorUsername: item.authorUsername ?? undefined,
      weight: vote === 'more' ? 1.3 : 1.6,
      sourceId: `thread-feedback:${insertedFeedback.id}`,
    });

    await tryRegeneratePreferenceContext();
    return NextResponse.json({ ok: true, threadFeedback: insertedFeedback });
  }

  if (action === 'thumbsup') {
    setFeedItemLiked(feedItemId, true);
    const shouldPassthroughLike = item.type === 'tweet'
      && !isHackerNewsSource(item.source)
      && !hasFeedItemInteraction(feedItemId, tweetLikeAppliedAction);

    if (reason) {
      const updated = updatePreferenceReasonByFeedItem(feedItemId, 'liked', reason);
      if (!updated) {
        insertPreference({
          feedItemId,
          signalType: 'liked',
          source: 'app_thumbsup',
          text: item.text,
          reason,
          authorUsername: item.authorUsername ?? undefined,
          weight: 1.2,
          sourceId: item.sourceId ?? undefined,
        });
      }
    } else {
      insertPreference({
        feedItemId,
        signalType: 'liked',
        source: 'app_thumbsup',
        text: item.text,
        authorUsername: item.authorUsername ?? undefined,
        weight: 1.2,
        sourceId: item.sourceId ?? undefined,
      });
    }

    await tryRegeneratePreferenceContext();
    return NextResponse.json({ ok: true, liked: true, disliked: false, shouldPassthroughLike });
  }

  if (action === 'thumbsdown') {
    setFeedItemDisliked(feedItemId, true);

    if (reason) {
      const updated = updatePreferenceReasonByFeedItem(feedItemId, 'disliked', reason);
      if (!updated) {
        insertPreference({
          feedItemId,
          signalType: 'disliked',
          source: 'app_thumbsdown',
          text: item.text,
          reason,
          authorUsername: item.authorUsername ?? undefined,
          weight: 1.5,
          sourceId: item.sourceId ?? undefined,
        });
      }
    } else {
      insertPreference({
        feedItemId,
        signalType: 'disliked',
        source: 'app_thumbsdown',
        text: item.text,
        authorUsername: item.authorUsername ?? undefined,
        weight: 1.5,
        sourceId: item.sourceId ?? undefined,
      });
    }

    await tryRegeneratePreferenceContext();
    return NextResponse.json({ ok: true, liked: false, disliked: true });
  }

  if (action === 'undo_thumbsup') {
    setFeedItemLiked(feedItemId, false);
    deletePreferenceByFeedItem(feedItemId, 'liked');
    await tryRegeneratePreferenceContext();

    return NextResponse.json({ ok: true, liked: false, disliked: false });
  }

  setFeedItemDisliked(feedItemId, false);
  deletePreferenceByFeedItem(feedItemId, 'disliked');
  await tryRegeneratePreferenceContext();

  return NextResponse.json({ ok: true, liked: false, disliked: false });
}
