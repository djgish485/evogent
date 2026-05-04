'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { SuggestionCard, type CodeFixProgress } from '@/components/feed/suggestion-card';
import { NotificationCard } from '@/components/feed/notification-card';
import { useOverlayDismiss } from '@/lib/overlay-dismiss';
import { scrollSearchHighlightIntoView } from '@/lib/search-detail-scroll';
import { textMatchesSearchQuery } from '@/lib/search-utils';
import type { SuggestionCreatorSessionTitles } from '@/lib/suggestion-creator-label';
import type { FeedItem, SuggestionStatus } from '@/types/feed';
import type { GroupType } from '@/components/feed/grouped-items-card';

interface GroupDetailViewProps {
  groupId: string;
  groupType: GroupType;
  title: string;
  items: FeedItem[];
  onClose: () => void;
  // Suggestion actions
  resolveSuggestionStatus?: (item: FeedItem) => SuggestionStatus;
  suggestionPendingActions?: Record<string, 'accept' | 'dismiss' | null>;
  suggestionFeedback?: Record<string, string>;
  codeFixProgressMap?: Record<string, CodeFixProgress>;
  onSuggestionAccept?: (item: FeedItem) => void;
  onSuggestionDismiss?: (item: FeedItem) => void;
  onSuggestionChat?: (item: FeedItem) => void;
  onSuggestionRetry?: (item: FeedItem) => void;
  onSuggestionCancel?: (item: FeedItem) => void;
  onSuggestionBatchAccept?: (items: FeedItem[]) => void;
  onSuggestionBatchDismiss?: (items: FeedItem[]) => void;
  creatorSessionTitles?: SuggestionCreatorSessionTitles;
  // Notification actions
  notificationPendingActions?: Record<string, 'dismiss' | null>;
  notificationFeedback?: Record<string, string>;
  onNotificationDismiss?: (item: FeedItem) => void;
  searchQuery?: string | null;
}

const overlayClass = 'fixed inset-0 z-[45] flex items-stretch justify-center bg-black/70 backdrop-blur-[2px]';
const sheetClass = 'relative z-10 h-full w-full overflow-y-auto overscroll-contain bg-black pb-28 text-zinc-100 shadow-2xl sm:mx-auto sm:max-w-3xl sm:border-x sm:border-zinc-800';
const headerClass = 'sticky top-0 z-20 border-b border-zinc-800/80 bg-black/95 backdrop-blur';
const contentContainerClass = 'mx-auto w-full max-w-3xl px-0 sm:px-2';

export function GroupDetailView({
  groupId,
  groupType,
  title,
  items,
  onClose,
  resolveSuggestionStatus,
  suggestionPendingActions = {},
  suggestionFeedback = {},
  codeFixProgressMap = {},
  onSuggestionAccept,
  onSuggestionDismiss,
  onSuggestionChat,
  onSuggestionRetry,
  onSuggestionCancel,
  onSuggestionBatchAccept,
  onSuggestionBatchDismiss,
  creatorSessionTitles,
  notificationPendingActions = {},
  notificationFeedback = {},
  onNotificationDismiss,
  searchQuery = null,
}: GroupDetailViewProps) {
  const detailRootRef = useRef<HTMLDivElement | null>(null);
  const { backdropProps } = useOverlayDismiss({
    enabled: true,
    onClose,
    policy: 'detail',
  });

  useEffect(() => {
    const previousBodyOverflow = document.body.style.overflow;
    const previousHtmlOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousHtmlOverflow;
    };
  }, []);

  const normalizedSearchQuery = searchQuery?.trim() || null;
  const hasDetailSearchMatch = useMemo(() => (
    Boolean(normalizedSearchQuery)
    && items.some((item) => textMatchesSearchQuery([item.title, item.text, item.reason].filter(Boolean).join(' '), normalizedSearchQuery))
  ), [items, normalizedSearchQuery]);

  useEffect(() => {
    if (!normalizedSearchQuery || !hasDetailSearchMatch) {
      return;
    }

    const root = detailRootRef.current;
    if (!root) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      scrollSearchHighlightIntoView(root);
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [hasDetailSearchMatch, normalizedSearchQuery]);

  const renderSuggestionItems = useCallback(() => {
    if (!resolveSuggestionStatus || !onSuggestionAccept || !onSuggestionDismiss) return null;

    return (
      <div className="space-y-3">
        {items.map((item) => {
          const status = resolveSuggestionStatus(item);
          return (
            <SuggestionCard
              key={item.id}
              item={item}
              status={status}
              renderDismissed
              pendingAction={suggestionPendingActions[item.id] ?? null}
              feedback={suggestionFeedback[item.id]}
              codeFixProgress={codeFixProgressMap[item.id] ?? null}
              creatorSessionTitles={creatorSessionTitles}
              onAccept={onSuggestionAccept}
              onDismiss={onSuggestionDismiss}
              onChatAboutSuggestion={onSuggestionChat}
              onRetry={onSuggestionRetry}
              onCancel={onSuggestionCancel}
              searchQuery={searchQuery}
            />
          );
        })}
      </div>
    );
  }, [items, resolveSuggestionStatus, suggestionPendingActions, suggestionFeedback, codeFixProgressMap, creatorSessionTitles, onSuggestionAccept, onSuggestionDismiss, onSuggestionChat, onSuggestionRetry, onSuggestionCancel, searchQuery]);

  const renderNotificationItems = useCallback(() => {
    if (!onNotificationDismiss) return null;

    return (
      <div className="space-y-3">
        {items.map((item) => (
          <NotificationCard
            key={item.id}
            item={item}
            pendingAction={notificationPendingActions[item.id] ?? null}
            feedback={notificationFeedback[item.id]}
            onDismiss={onNotificationDismiss}
            showTaskContext
            searchQuery={searchQuery}
          />
        ))}
      </div>
    );
  }, [items, notificationPendingActions, notificationFeedback, onNotificationDismiss, searchQuery]);

  const pendingItems = groupType === 'suggestion' && resolveSuggestionStatus
    ? items.filter((item) => resolveSuggestionStatus(item) === 'pending')
    : [];
  const hasBatchActions = groupType === 'suggestion' && onSuggestionBatchAccept && onSuggestionBatchDismiss && pendingItems.length > 0;
  const hasPendingAction = groupType === 'suggestion'
    ? items.some((item) => suggestionPendingActions[item.id] != null)
    : items.some((item) => notificationPendingActions[item.id] != null);

  return (
    <div
      data-testid="group-detail-overlay"
      data-group-id={groupId}
      className={overlayClass}
    >
      <div
        aria-hidden="true"
        className="absolute inset-0 touch-none"
        {...backdropProps}
      />
      <div ref={detailRootRef} data-testid="group-detail-sheet" data-search-detail-root="" className={sheetClass}>
        <div data-testid="group-detail-header" className={headerClass}>
          <div className={`${contentContainerClass} flex items-center justify-between gap-3 pt-1 pb-1.5 sm:py-2`}>
            <div className="flex min-w-0 items-center gap-3">
              <button
                type="button"
                data-testid="group-detail-back-button"
                className="inline-flex min-h-11 items-center gap-2 rounded-full border border-zinc-700 bg-zinc-950 px-4 text-sm font-medium text-zinc-100 transition-colors hover:bg-zinc-900 sm:text-base"
                onClick={onClose}
              >
                <span aria-hidden="true" className="text-base leading-none sm:text-lg">&larr;</span>
                <span>Back</span>
              </button>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-zinc-100">{title}</p>
                <p className="truncate text-xs text-zinc-500">{items.length} item{items.length === 1 ? '' : 's'}</p>
              </div>
            </div>

            {hasBatchActions && (
              <div className="flex flex-wrap items-center gap-2">
                {hasBatchActions ? (
                  <>
                    <button
                      type="button"
                      data-testid="group-detail-accept-all"
                      disabled={hasPendingAction}
                      onClick={() => onSuggestionBatchAccept!(pendingItems)}
                      className="min-h-11 rounded-lg border border-emerald-700 bg-emerald-900/30 px-3 py-1.5 text-xs font-medium text-emerald-100 transition-colors hover:bg-emerald-900/45 disabled:cursor-not-allowed disabled:opacity-65"
                    >
                      Accept All
                    </button>
                    <button
                      type="button"
                      data-testid="group-detail-dismiss-all"
                      disabled={hasPendingAction}
                      onClick={() => onSuggestionBatchDismiss!(pendingItems)}
                      className="min-h-11 rounded-lg border border-zinc-700 bg-zinc-900/45 px-3 py-1.5 text-xs font-medium text-zinc-200 transition-colors hover:bg-zinc-900/70 disabled:cursor-not-allowed disabled:opacity-65"
                    >
                      Dismiss All
                    </button>
                  </>
                ) : null}
              </div>
            )}
          </div>
        </div>

        <div className={`${contentContainerClass} space-y-3 py-3 sm:py-4`}>
          {groupType === 'suggestion' && renderSuggestionItems()}
          {groupType === 'notification' && renderNotificationItems()}

          {items.length === 0 && (
            <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
              <p className="text-sm text-zinc-400">No items in this group.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
