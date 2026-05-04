'use client';

import { SuggestionCard, type CodeFixProgress } from '@/components/feed/suggestion-card';
import type { SuggestionLifecycleLane } from '@/lib/suggestion-status-lanes';
import type { SuggestionCreatorSessionTitles } from '@/lib/suggestion-creator-label';
import type { FeedItem, SuggestionStatus } from '@/types/feed';

interface SuggestionStatusLaneProps {
  lane: SuggestionLifecycleLane;
  items: FeedItem[];
  resolveSuggestionStatus: (item: FeedItem) => SuggestionStatus;
  getSuggestionPendingAction: (item: FeedItem) => 'accept' | 'dismiss' | null;
  getSuggestionFeedback: (item: FeedItem) => string | null | undefined;
  codeFixProgressMap: Record<string, CodeFixProgress | null>;
  batchActions?: {
    acceptAll?: { label: string; disabled: boolean; onClick: () => void };
    dismissAll?: { label: string; disabled: boolean; onClick: () => void };
  };
  onSuggestionAccept: (item: FeedItem) => void;
  onSuggestionDismiss: (item: FeedItem) => void;
  onSuggestionChat: (item: FeedItem) => void;
  onSuggestionRetry: (item: FeedItem) => void;
  onSuggestionCancel: (item: FeedItem) => void;
  creatorSessionTitles?: SuggestionCreatorSessionTitles;
}

interface LaneMeta {
  title: string;
  emptyLabel: string;
  dotClassName: string;
  countClassName: string;
}

function getLaneMeta(lane: SuggestionLifecycleLane): LaneMeta {
  switch (lane) {
    case 'pending':
      return {
        title: 'Pending',
        emptyLabel: 'No pending suggestions right now.',
        dotClassName: 'bg-zinc-300',
        countClassName: 'border-zinc-700/70 bg-zinc-900/55 text-zinc-200',
      };
    case 'active':
      return {
        title: 'Active',
        emptyLabel: 'Nothing is running right now.',
        dotClassName: 'bg-amber-400',
        countClassName: 'border-amber-700/60 bg-amber-950/35 text-amber-100',
      };
    case 'complete':
      return {
        title: 'Complete',
        emptyLabel: 'Completed suggestions will appear here.',
        dotClassName: 'bg-emerald-400',
        countClassName: 'border-emerald-700/60 bg-emerald-950/30 text-emerald-100',
      };
  }
}

export function SuggestionStatusLane({
  lane,
  items,
  resolveSuggestionStatus,
  getSuggestionPendingAction,
  getSuggestionFeedback,
  codeFixProgressMap,
  batchActions,
  onSuggestionAccept,
  onSuggestionDismiss,
  onSuggestionChat,
  onSuggestionRetry,
  onSuggestionCancel,
  creatorSessionTitles,
}: SuggestionStatusLaneProps) {
  const meta = getLaneMeta(lane);

  return (
    <section
      data-testid={`suggestion-lane-${lane}`}
      className="flex flex-col rounded-[1.35rem] border border-zinc-800/70 bg-zinc-950/45 px-3 py-3 shadow-[0_12px_34px_rgba(0,0,0,0.12)] sm:px-4"
    >
      <div className="border-b border-white/8 pb-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className={`inline-flex h-2.5 w-2.5 rounded-full ${meta.dotClassName}`} aria-hidden="true" />
            <h2 className="text-base font-semibold text-zinc-100">{meta.title}</h2>
            <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${meta.countClassName}`}>
              {items.length}
            </span>
          </div>

          {batchActions ? (
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {batchActions.acceptAll ? (
                <button
                  type="button"
                  data-testid={`suggestion-lane-accept-all-${lane}`}
                  disabled={batchActions.acceptAll.disabled}
                  onClick={batchActions.acceptAll.onClick}
                  className="min-h-8 rounded-full border border-emerald-700/70 bg-emerald-950/35 px-3 py-1 text-xs font-medium text-emerald-100 transition-colors hover:border-emerald-500/80 hover:bg-emerald-900/45 disabled:cursor-not-allowed disabled:opacity-65"
                >
                  {batchActions.acceptAll.label}
                </button>
              ) : null}
              {batchActions.dismissAll ? (
                <button
                  type="button"
                  data-testid={`suggestion-lane-dismiss-all-${lane}`}
                  disabled={batchActions.dismissAll.disabled}
                  onClick={batchActions.dismissAll.onClick}
                  className="min-h-8 rounded-full border border-zinc-700/70 bg-black/20 px-3 py-1 text-xs font-medium text-zinc-300 transition-colors hover:border-zinc-500 hover:bg-zinc-900/60 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-65"
                >
                  {batchActions.dismissAll.label}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-3 space-y-2.5">
        {items.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-zinc-800/70 bg-black/15 px-3 py-3 text-sm text-zinc-500">
            {meta.emptyLabel}
          </div>
        ) : (
          items.map((item) => {
            const status = resolveSuggestionStatus(item);
            return (
              <SuggestionCard
                key={item.id}
                item={item}
                status={status}
                renderDismissed
                pendingAction={getSuggestionPendingAction(item)}
                feedback={getSuggestionFeedback(item)}
                codeFixProgress={codeFixProgressMap[item.id] ?? null}
                creatorSessionTitles={creatorSessionTitles}
                onAccept={onSuggestionAccept}
                onDismiss={onSuggestionDismiss}
                onChatAboutSuggestion={onSuggestionChat}
                onRetry={onSuggestionRetry}
                onCancel={onSuggestionCancel}
              />
            );
          })
        )}
      </div>
    </section>
  );
}
