'use client';

import { useCallback, useId, useMemo, useState } from 'react';
import { ContentCard } from '@/components/feed/content-card';
import { DislikedItemTombstone } from '@/components/feed/disliked-item-tombstone';
import { ThreadGroupHeader } from '@/components/feed/thread-group-header';
import type { ThreadFeedbackVote } from '@/components/feed/thread-feedback-control';
import { AUTH_REQUIRED_MESSAGE, isAuthFailure } from '@/lib/auth-failure';
import { textMatchesSearchQuery } from '@/lib/search-utils';
import { sanitizeThreadColor, THREAD_COLOR_PALETTE, type ThreadTint } from '@/lib/thread-colors';
import type { FeedbackProbeMetadata, FeedItem, FeedProminence } from '@/types/feed';

const NEUTRAL_THREAD_TINT: ThreadTint = {
  name: 'neutral',
  bg: 'rgb(27 27 28)',
  border: 'rgba(161,161,170,0.45)',
  itemBorder: 'rgba(161,161,170,0.22)',
  swatch: 'rgb(161 161 170)',
  text: '#d4d4d8',
};
const THREAD_CARD_CLASS = 'overflow-hidden rounded-2xl border [&>article]:border-transparent [&>article]:shadow-none [&>article:hover]:border-transparent';
const THREAD_BRIDGE_LINE_COLOR = 'rgba(113,113,122,0.34)';
const THREAD_BRIDGE_DOT_RING_COLOR = 'rgba(113,113,122,0.24)';

interface ThreadGroupProps {
  threadId: string;
  threadTitle: string;
  threadSubtitle: string | null;
  threadProminence: FeedProminence | null;
  feedbackProbe?: FeedbackProbeMetadata | null;
  sourceItemIds?: string[];
  continuing: boolean;
  analysisItems: FeedItem[];
  items: FeedItem[];
  agentName: string;
  onChat: (item: FeedItem) => void;
  onOpenDetail: (item: FeedItem) => void;
  searchQuery?: string | null;
  onSubmitFeedback: (input: {
    threadId: string;
    threadTitle: string;
    vote: ThreadFeedbackVote;
    reason: string;
    feedbackProbe?: FeedbackProbeMetadata | null;
    sourceItemIds?: string[];
  }) => Promise<void>;
}

function renderContentCard(
  item: FeedItem,
  agentName: string,
  onChat: (item: FeedItem) => void,
  onOpenDetail: (item: FeedItem) => void,
  searchQuery: string | null | undefined,
  options?: {
    suppressedChildPreviewIds?: string[];
    threadTint?: ThreadTint;
  },
) {
  const card = (
    <ContentCard
      key={item.id}
      item={item}
      suppressedChildPreviewIds={options?.suppressedChildPreviewIds}
      agentName={agentName}
      onChat={onChat}
      onOpenDetail={onOpenDetail}
      searchQuery={searchQuery}
    />
  );
  if (!options?.threadTint) return card;
  return (
    <div
      key={item.id}
      className={THREAD_CARD_CLASS}
      style={{
        borderColor: options.threadTint.itemBorder,
        ['--initials-avatar-bg' as string]: options.threadTint.border,
      }}
    >
      {card}
    </div>
  );
}

function getFeedItemSearchText(item: FeedItem): string {
  return [item.title, item.text, item.excerpt, item.reason].filter(Boolean).join(' ');
}

function getFeedItemMatchTimestamp(item: FeedItem): string {
  return item.publishedAt || item.createdAt;
}

function sortThreadItemsForSearch(items: FeedItem[], searchQuery: string | null | undefined): FeedItem[] {
  if (!searchQuery) {
    return items;
  }

  const matchCache = new Map<string, boolean>();
  const isMatch = (item: FeedItem) => {
    const cached = matchCache.get(item.id);
    if (cached !== undefined) {
      return cached;
    }
    const matches = textMatchesSearchQuery(getFeedItemSearchText(item), searchQuery);
    matchCache.set(item.id, matches);
    return matches;
  };

  if (!items.some(isMatch)) {
    return items;
  }

  return [...items].sort((left, right) => {
    const leftMatches = isMatch(left);
    const rightMatches = isMatch(right);
    if (leftMatches !== rightMatches) {
      return leftMatches ? -1 : 1;
    }
    if (leftMatches && rightMatches) {
      const byTimestamp = getFeedItemMatchTimestamp(right).localeCompare(getFeedItemMatchTimestamp(left));
      if (byTimestamp !== 0) {
        return byTimestamp;
      }
    }
    return 0;
  });
}

function getItemBridge(item: FeedItem): string {
  return typeof item.metadata?.bridge === 'string'
    ? item.metadata.bridge.trim()
    : '';
}

function getThreadTombstoneLabel(threadTitle: string): string {
  const title = threadTitle.trim();
  return title ? `Thread: ${title}` : 'Thread';
}

function getThreadDislikeErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

async function postThreadDislikeInteraction(
  feedItemId: string,
  action: 'thumbsdown' | 'undo_thumbsdown',
  reason?: string,
): Promise<void> {
  const response = await fetch('/api/interactions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      feedItemId,
      action,
      reason: reason || undefined,
    }),
  });

  if (!response.ok) {
    throw new Error(
      isAuthFailure(response, null)
        ? AUTH_REQUIRED_MESSAGE
        : `Failed to update thread feedback (${response.status})`,
    );
  }
}

function ThreadItemBridge({
  bridge,
  threadTint,
}: {
  bridge: string;
  threadTint: ThreadTint;
}) {
  return (
    <div className="mb-3 flex min-w-0 items-center gap-2.5 pl-[18px] pr-4">
      <span
        aria-hidden="true"
        className="h-2 w-2 shrink-0 rounded-full"
        style={{
          backgroundColor: threadTint.swatch,
          boxShadow: `0 0 0 3px ${THREAD_BRIDGE_DOT_RING_COLOR}`,
        }}
      />
      <p className="min-w-0 shrink break-words text-sm italic leading-5 text-zinc-300 sm:text-[15px]">
        {bridge}
      </p>
      <span
        aria-hidden="true"
        className="h-px min-w-6 flex-1"
        style={{ backgroundColor: THREAD_BRIDGE_LINE_COLOR }}
      />
    </div>
  );
}

export function ThreadGroup({
  threadId,
  threadTitle,
  threadSubtitle,
  threadProminence,
  feedbackProbe = null,
  sourceItemIds = [],
  continuing,
  analysisItems,
  items,
  agentName,
  onChat,
  onOpenDetail,
  searchQuery = null,
  onSubmitFeedback,
}: ThreadGroupProps) {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isDismissedInSession, setIsDismissedInSession] = useState(false);
  const [dismissPending, setDismissPending] = useState(false);
  const [dismissError, setDismissError] = useState<string | null>(null);
  const [tombstoneReason, setTombstoneReason] = useState('');
  const [tombstoneReasonSaved, setTombstoneReasonSaved] = useState(false);
  const [tombstoneSavingReason, setTombstoneSavingReason] = useState(false);
  const [tombstoneError, setTombstoneError] = useState<string | null>(null);
  const contentsId = useId();
  const pinnedAnalysisIds = analysisItems.map((item) => item.id);
  const threadFeedItemIds = useMemo(() => Array.from(new Set(
    [...analysisItems, ...items].map((item) => item.id).filter(Boolean),
  )), [analysisItems, items]);
  const threadColor = sanitizeThreadColor(items[0]?.metadata?.thread?.color);
  const threadTint = threadColor ? THREAD_COLOR_PALETTE[threadColor] : NEUTRAL_THREAD_TINT;
  const hiddenItemCount = analysisItems.length + items.length;
  const hiddenItemLabel = hiddenItemCount === 1 ? 'item' : 'items';
  const postThreadDislike = useCallback(async (
    action: 'thumbsdown' | 'undo_thumbsdown',
    reason?: string,
  ) => {
    if (threadFeedItemIds.length === 0) {
      throw new Error('Unable to find thread items to update.');
    }

    await Promise.all(threadFeedItemIds.map((feedItemId) => (
      postThreadDislikeInteraction(feedItemId, action, reason)
    )));
  }, [threadFeedItemIds]);
  const handleThumbsDownThread = useCallback(() => {
    if (dismissPending || isDismissedInSession) return;

    setDismissPending(true);
    setDismissError(null);
    setTombstoneError(null);
    setTombstoneReason('');
    setTombstoneReasonSaved(false);
    setIsDismissedInSession(true);

    void (async () => {
      try {
        await postThreadDislike('thumbsdown');
      } catch (error) {
        setIsDismissedInSession(false);
        setDismissError(getThreadDislikeErrorMessage(error, 'Failed to remove thread from the feed.'));
      } finally {
        setDismissPending(false);
      }
    })();
  }, [dismissPending, isDismissedInSession, postThreadDislike]);
  const handleUndoThreadDislike = useCallback(async () => {
    if (dismissPending || tombstoneSavingReason) return;

    setDismissPending(true);
    setTombstoneError(null);
    setIsDismissedInSession(false);

    try {
      await postThreadDislike('undo_thumbsdown');
      setTombstoneReason('');
      setTombstoneReasonSaved(false);
    } catch (error) {
      setIsDismissedInSession(true);
      setTombstoneError(getThreadDislikeErrorMessage(error, 'Failed to undo thread removal.'));
    } finally {
      setDismissPending(false);
    }
  }, [dismissPending, postThreadDislike, tombstoneSavingReason]);
  const handleThreadTombstoneReasonSubmit = useCallback(async (reason: string) => {
    const trimmedReason = reason.trim();
    if (!trimmedReason) {
      setTombstoneError(null);
      setTombstoneReasonSaved(true);
      return;
    }

    setTombstoneSavingReason(true);
    setTombstoneError(null);
    try {
      await postThreadDislike('thumbsdown', trimmedReason);
      setTombstoneReason(trimmedReason);
      setTombstoneReasonSaved(true);
    } catch (error) {
      setTombstoneError(getThreadDislikeErrorMessage(error, 'Failed to save reason.'));
    } finally {
      setTombstoneSavingReason(false);
    }
  }, [postThreadDislike]);
  const headerProps = {
    threadId,
    threadTitle,
    threadSubtitle,
    threadProminence,
    feedbackProbe,
    sourceItemIds,
    continuing,
    threadTint,
    isCollapsed,
    contentsId,
    thumbsDownPending: dismissPending,
    onToggleCollapsed: () => setIsCollapsed((current) => !current),
    onThumbsDownThread: handleThumbsDownThread,
    onSubmitFeedback,
  };
  const visibleAnalysisItems = sortThreadItemsForSearch(analysisItems, searchQuery);
  const visibleItems = sortThreadItemsForSearch(items, searchQuery);

  if (isDismissedInSession) {
    return (
      <section className="pt-4">
        <DislikedItemTombstone
          label={getThreadTombstoneLabel(threadTitle)}
          pendingReason={tombstoneReason}
          savingReason={dismissPending || tombstoneSavingReason}
          error={tombstoneError}
          reasonSaved={tombstoneReasonSaved}
          onPendingReasonChange={setTombstoneReason}
          onUndo={handleUndoThreadDislike}
          onSubmitReason={handleThreadTombstoneReasonSubmit}
        />
      </section>
    );
  }

  return (
    <section className="pt-4">
      <ThreadGroupHeader {...headerProps} />
      {dismissError ? <p className="mt-2 px-4 text-sm text-red-300">{dismissError}</p> : null}
      <div id={contentsId}>
        {isCollapsed ? (
          <button
            type="button"
            aria-controls={contentsId}
            onClick={() => setIsCollapsed(false)}
            className="mt-2 w-full rounded-xl border border-zinc-800 bg-zinc-950/70 px-4 py-3 text-left text-sm font-medium text-zinc-300 transition hover:border-zinc-700 hover:bg-zinc-900/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/60"
          >
            {hiddenItemCount} {hiddenItemLabel} hidden - tap to expand
          </button>
        ) : (
          <>
            {analysisItems.length > 0 ? (
              <div className="mt-2 space-y-3">
                <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-zinc-400">Synthesis</p>
                {visibleAnalysisItems.map((item) => {
                  const bridge = getItemBridge(item);

                  return (
                    <div key={item.id}>
                      {bridge ? (
                        <ThreadItemBridge bridge={bridge} threadTint={threadTint} />
                      ) : null}
                      {renderContentCard(item, agentName, onChat, onOpenDetail, searchQuery, {
                        threadTint,
                      })}
                    </div>
                  );
                })}
              </div>
            ) : null}
            <div className="mt-2 space-y-3">
              {visibleItems.map((item) => {
                const bridge = getItemBridge(item);

                return (
                  <div key={item.id}>
                    {bridge ? (
                      <ThreadItemBridge bridge={bridge} threadTint={threadTint} />
                    ) : null}
                    {renderContentCard(item, agentName, onChat, onOpenDetail, searchQuery, {
                      suppressedChildPreviewIds: pinnedAnalysisIds,
                      threadTint,
                    })}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
