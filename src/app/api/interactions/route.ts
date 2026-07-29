import { NextResponse } from 'next/server';
import { cancelCodeFixSuggestionWork } from '@/lib/code-fix-orchestrator';
import {
  getFeedItemById,
  getInteractionStates,
  hasFeedItemInteraction,
  recordFeedItemInteraction,
  setFeedItemDisliked,
  setFeedItemLiked,
  setFeedItemSuggestionStatus,
} from '@/lib/db/feed';
import { getFeedSuggestionType, parseSuggestionActions } from '@/lib/feed-suggestions';
import { dispatchLifeActionExecution } from '@/lib/life-execution';
import { cancelSourceSetup } from '@/lib/source-setup';
import {
  recordFeedEngagementSession,
  type FeedEngagementPhase,
} from '@/lib/db/feed-engagement';
import { deletePreferenceByFeedItem, insertPreference, updatePreferenceReasonByFeedItem } from '@/lib/db/preferences';
import { insertThreadFeedback, type ThreadFeedbackVote } from '@/lib/db/thread-feedback';
import { regeneratePreferenceContext } from '@/lib/preferences-context';
import { withFeedMutationLock } from '@/lib/feed-mutation-lock';

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

async function postUnlocked(request: Request) {
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
    'view',
    'expand',
    'engagement',
  ]);

  if (!feedItemId || !action || !supportedActions.has(action)) {
    return NextResponse.json({ error: 'feedItemId and action are required' }, { status: 400 });
  }

  const item = getFeedItemById(feedItemId);
  if (!item) {
    return NextResponse.json({ error: 'Feed item not found' }, { status: 404 });
  }
  const isPhoneNotification = item.type === 'notification'
    && item.source === 'phone-notification';

  if (isPhoneNotification) {
    // These cards are a deterministic local UI lane, not taste, reflection, or
    // attention evidence. Dismissal uses /api/internal/notifications/resolve;
    // every general interaction is acknowledged without writing content or a
    // content-linked signal into an agent-readable evidence store.
    return NextResponse.json({
      ok: true,
      action,
      ignoredForAgentEvidence: true,
    });
  }

  if (action === 'engagement') {
    const rawEngagement = payload.engagement;
    if (!rawEngagement || typeof rawEngagement !== 'object' || Array.isArray(rawEngagement)) {
      return NextResponse.json({ error: 'engagement is required' }, { status: 400 });
    }

    const engagement = rawEngagement as Record<string, unknown>;
    const sessionId = trimPayloadString(engagement.sessionId);
    const rawPhase = trimPayloadString(engagement.phase)?.toLowerCase() ?? '';
    const phase: FeedEngagementPhase | null = rawPhase === 'open'
      || rawPhase === 'checkpoint'
      || rawPhase === 'close'
      ? rawPhase
      : null;

    if (!sessionId || !phase) {
      return NextResponse.json({ error: 'engagement.sessionId and engagement.phase are required' }, { status: 400 });
    }

    try {
      const session = recordFeedEngagementSession({
        sessionId,
        feedItemId,
        phase,
        activeDwellMs: typeof engagement.activeDwellMs === 'number'
          ? engagement.activeDwellMs
          : undefined,
        scrollDepthPercent: typeof engagement.scrollDepthPercent === 'number'
          ? engagement.scrollDepthPercent
          : undefined,
        userScrolled: engagement.userScrolled === true,
        surface: trimPayloadString(engagement.surface) ?? undefined,
        itemSnapshot: {
          type: item.type,
          source: item.source,
          sourceId: item.sourceId,
          authorUsername: item.authorUsername,
          title: item.title,
          text: item.text,
        },
      });

      // Open/checkpoint writes stay cheap. A completed detail visit rebuilds the bounded current
      // profile so the next agent receives the new attention evidence without reading this ledger.
      if (phase === 'close') {
        await tryRegeneratePreferenceContext();
      }

      return NextResponse.json({ ok: true, engagement: session });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to record engagement';
      return NextResponse.json({ error: message }, { status: 400 });
    }
  }

  if (action === 'view' || action === 'expand') {
    recordFeedItemInteraction(feedItemId, action);
    return NextResponse.json({ ok: true, action });
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

    // Auto-added sources are act-show-undo: a USER dismissing the announcement card IS the
    // undo (delete the recipe/queue + opt the source out). But an AGENT dismissing it — the
    // curator doing routine suggestion-dedup housekeeping (CLAUDE.md tells it to dismiss
    // overlapping cards) — must NEVER cancel a working source. It silently killed Instagram
    // this way. So cancellation requires an explicit userInitiated flag that only the feed UI
    // sends; a programmatic dismiss just marks the card dismissed and leaves the source intact.
    const userInitiated = payload.userInitiated === true;
    if (action === 'dismiss_suggestion' && getFeedSuggestionType(item) === 'source_setup') {
      if (userInitiated) {
        const cancellation = cancelSourceSetup(item);
        if (!cancellation.cancelled) {
          const sourceLabel = cancellation.source || 'invalid-source';
          console.warn(
            `[interactions] source_setup dismiss: authoritative cancellation failed for ${sourceLabel}`,
          );
          return NextResponse.json(
            {
              error: 'Source cancellation could not be made durable; the source remains active.',
            },
            { status: 500 },
          );
        }
      } else {
        console.warn(`[interactions] source_setup dismissed WITHOUT userInitiated (agent/dedup) — hiding card, keeping source ${typeof item.metadata?.sourceName === 'string' ? item.metadata.sourceName : ''}`);
      }
    }

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

    // Approve-to-execute: a life_admin card carrying an executionSpec was
    // written to be acted on, and the user's approval is the go signal. The
    // action dispatches to the curator life-actions agent under the guardrail
    // wrapper (data/life-execute-prompt*.md); dispatch failure degrades to a
    // plain accept so approval is never lost.
    const dispatchableSuggestionTypes = new Set(['life_admin', 'source_setup']);
    if (action === 'accept_suggestion' && dispatchableSuggestionTypes.has(getFeedSuggestionType(item))) {
      // Dynamic approval buttons: the tap names ONE of the card's agent-authored actions.
      // Only the label crosses the API — the instruction is read back from the card's own
      // metadata, so this endpoint cannot be used to inject arbitrary execution text.
      const chosenLabelRaw = payload.chosenAction && typeof payload.chosenAction === 'object' && !Array.isArray(payload.chosenAction)
        ? (payload.chosenAction as Record<string, unknown>).label
        : null;
      const chosenLabel = typeof chosenLabelRaw === 'string' ? chosenLabelRaw.trim() : '';
      const cardActions = parseSuggestionActions(item.metadata?.actions);
      const chosenAction = chosenLabel
        ? cardActions.find((entry) => entry.label === chosenLabel) ?? null
        : null;
      if (chosenLabel && !chosenAction) {
        return NextResponse.json({
          error: `Action "${chosenLabel}" is not offered by this suggestion.`,
        }, { status: 400 });
      }
      if (
        getFeedSuggestionType(item) === 'source_setup'
        && chosenAction?.kind === 'cancel_source'
      ) {
        // "Not this app" is an owner cancellation, not a cosmetic acknowledgement.
        // Commit the SQLite tombstone first; only then resolve the card.
        const cancellation = cancelSourceSetup(item);
        if (!cancellation.cancelled) {
          const sourceLabel = cancellation.source || 'invalid-source';
          console.warn(
            `[interactions] source_setup action: authoritative cancellation failed for ${sourceLabel}`,
          );
          return NextResponse.json(
            {
              error: 'Source cancellation could not be made durable; the source remains active.',
            },
            { status: 500 },
          );
        }
        setFeedItemSuggestionStatus(feedItemId, 'dismissed');
        return NextResponse.json({
          ok: true,
          suggestionStatus: 'dismissed',
          source: cancellation.source,
        });
      }
      const executionSpec = typeof item.metadata?.executionSpec === 'string'
        ? item.metadata.executionSpec.trim()
        : '';
      const instruction = chosenAction
        ? chosenAction.kind === 'execute' && chosenAction.instruction
          ? `The user approved this specific action: "${chosenAction.label}".\n\n${chosenAction.instruction}`
          : '' // acknowledge-kind action: plain accept, nothing to execute
        : executionSpec;
      if (instruction) {
        const dispatch = await dispatchLifeActionExecution({
          feedItemId,
          title: item.title ?? '',
          executionSpec: instruction,
        });
        if (dispatch.ok) {
          setFeedItemSuggestionStatus(feedItemId, 'dispatched');
          return NextResponse.json({
            ok: true,
            suggestionStatus: 'dispatched',
            executionSessionKey: dispatch.sessionKey,
          });
        }
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

export async function POST(request: Request) {
  return withFeedMutationLock(() => postUnlocked(request));
}
