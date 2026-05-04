'use client';

import {
  canHideSuggestion,
  getFeedSuggestionAcceptLabel,
  getFeedSuggestionBatchSummary,
  getFeedSuggestionDefaultTitle,
  getFeedSuggestionGroupPreview,
  getFeedSuggestionTypeBadgeLabel,
  getSuggestionStatusFeedback,
  getSuggestionStatusLabel,
  isSuggestionActionable,
  isCodeFixSuggestion,
} from '@/lib/feed-suggestions';
import type { FeedItem, SuggestionStatus } from '@/types/feed';

interface SuggestionBatchEntry {
  item: FeedItem;
  status: SuggestionStatus;
  pendingAction: 'accept' | 'dismiss' | null;
  feedback?: string | null;
}

interface SuggestionBatchCardProps {
  groupId: string;
  title: string;
  entries: SuggestionBatchEntry[];
  collapsed: boolean;
  onToggleCollapse: () => void;
  onAcceptAll: (items: FeedItem[]) => void;
  onDismissAll: (items: FeedItem[]) => void;
  onAccept: (item: FeedItem) => void;
  onDismiss: (item: FeedItem) => void;
}

const BASE_CARD_CLASS_NAME = 'group relative w-full overflow-hidden rounded-2xl border border-zinc-800/80 bg-zinc-950/90 p-4 shadow-[0_12px_36px_rgba(0,0,0,0.18)] transition-[background-color,border-color,box-shadow] hover:border-zinc-700/80 hover:bg-zinc-950 hover:shadow-[0_18px_44px_rgba(0,0,0,0.24)]';
const BASE_ROW_CLASS_NAME = 'relative overflow-hidden rounded-2xl border border-zinc-800/80 bg-zinc-950/90 p-3 shadow-[0_12px_30px_rgba(0,0,0,0.16)] transition-[background-color,border-color,box-shadow] hover:border-zinc-700/80 hover:bg-zinc-950 hover:shadow-[0_16px_38px_rgba(0,0,0,0.22)]';

export function SuggestionBatchCard({
  groupId,
  title,
  entries,
  collapsed,
  onToggleCollapse,
  onAcceptAll,
  onDismissAll,
  onAccept,
  onDismiss,
}: SuggestionBatchCardProps) {
  const pendingEntries = entries.filter((entry) => isSuggestionActionable(entry.status));
  const dismissableEntries = entries.filter((entry) => entry.status !== 'dismissed');
  const hasPendingAction = entries.some((entry) => entry.pendingAction !== null);
  const batchSummary = getFeedSuggestionBatchSummary(entries.map((entry) => entry.item));

  return (
    <article
      data-testid="suggestion-group-card"
      data-group-id={groupId}
      className={BASE_CARD_CLASS_NAME}
    >
      <div className="pointer-events-none absolute inset-0 bg-amber-950/10" />
      <div className="relative">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <button
            type="button"
            data-testid="suggestion-group-toggle"
            onClick={onToggleCollapse}
            className="flex min-w-0 flex-1 items-center gap-3 text-left"
          >
            <span className="mt-0.5 text-xs text-zinc-400">{collapsed ? '▸' : '▾'}</span>
            <div className="min-w-0">
              <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-amber-300">Pending suggestions</p>
              <h3 className="truncate text-base font-semibold text-zinc-100">{title}</h3>
              {batchSummary && <p className="mt-1 text-xs text-zinc-400">{batchSummary}</p>}
            </div>
          </button>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="suggestion-group-accept-all"
              disabled={hasPendingAction || pendingEntries.length === 0}
              onClick={() => onAcceptAll(pendingEntries.map((entry) => entry.item))}
              className="min-h-11 rounded-lg border border-emerald-700 bg-emerald-900/30 px-3 py-1.5 text-xs font-medium text-emerald-100 transition-colors hover:bg-emerald-900/45 disabled:cursor-not-allowed disabled:opacity-65"
            >
              {hasPendingAction ? 'Working...' : 'Accept All'}
            </button>
            <button
              type="button"
              data-testid="suggestion-group-dismiss-all"
              disabled={hasPendingAction || dismissableEntries.length === 0}
              onClick={() => onDismissAll(dismissableEntries.map((entry) => entry.item))}
              className="min-h-11 rounded-lg border border-zinc-700 bg-zinc-900/45 px-3 py-1.5 text-xs font-medium text-zinc-200 transition-colors hover:bg-zinc-900/70 disabled:cursor-not-allowed disabled:opacity-65"
            >
              {hasPendingAction ? 'Working...' : 'Dismiss All'}
            </button>
          </div>
        </div>

        {!collapsed && (
          <div className="mt-4 space-y-3">
            {entries.map(({ item, status, pendingAction, feedback }) => {
              const isCodeFix = isCodeFixSuggestion(item);
              const titleText = item.title || getFeedSuggestionDefaultTitle(item);
              const previewText = getFeedSuggestionGroupPreview(item);
              const resolvedFeedback = feedback ?? getSuggestionStatusFeedback(item, status);
              const canAccept = isSuggestionActionable(status);
              const hideable = canHideSuggestion(status);
              const rowTintClassName = isCodeFix ? 'bg-amber-950/10' : 'bg-cyan-950/10';
              const typeBadgeClassName = isCodeFix
                ? 'rounded-full border border-amber-600/70 bg-amber-900/35 px-2 py-0.5 text-[11px] font-medium text-amber-100'
                : 'rounded-full border border-cyan-600/70 bg-cyan-900/35 px-2 py-0.5 text-[11px] font-medium text-cyan-100';
              const statusClassName = status === 'failed'
                ? 'rounded-full border border-red-600/70 bg-red-900/45 px-2 py-0.5 text-[11px] font-medium text-red-100'
                : status === 'merged' || status === 'accepted'
                  ? 'rounded-full border border-emerald-600/70 bg-emerald-900/45 px-2 py-0.5 text-[11px] font-medium text-emerald-100'
                  : status === 'dismissed'
                    ? 'rounded-full border border-zinc-700/70 bg-zinc-900/40 px-2 py-0.5 text-[11px] font-medium text-zinc-200'
                    : 'rounded-full border border-amber-600/70 bg-amber-900/45 px-2 py-0.5 text-[11px] font-medium text-amber-100';

              return (
                <div
                  key={item.id}
                  data-testid="suggestion-group-row"
                  data-item-id={item.id}
                  className={BASE_ROW_CLASS_NAME}
                >
                  <div className={`pointer-events-none absolute inset-0 ${rowTintClassName}`} />
                  <div className="relative flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-zinc-100">{titleText}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        <span className={typeBadgeClassName}>
                          {getFeedSuggestionTypeBadgeLabel(item)}
                        </span>
                      </div>
                      {previewText && (
                        <p className="mt-2 line-clamp-2 text-xs leading-5 text-zinc-400">{previewText}</p>
                      )}
                      {resolvedFeedback && (
                        <p className={`mt-2 text-xs ${resolvedFeedback.toLowerCase().includes('failed') ? 'text-red-300' : 'text-emerald-300'}`}>
                          {resolvedFeedback}
                        </p>
                      )}
                    </div>

                    <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                      {hideable ? (
                        <>
                          <span className={statusClassName}>
                            {getSuggestionStatusLabel(status)}
                          </span>
                          <button
                            type="button"
                            disabled={pendingAction !== null}
                            onClick={() => onDismiss(item)}
                            className="min-h-11 rounded-lg border border-zinc-700 bg-zinc-900/45 px-3 py-1.5 text-xs font-medium text-zinc-200 transition-colors hover:bg-zinc-900/70 disabled:cursor-not-allowed disabled:opacity-65"
                          >
                            {pendingAction === 'dismiss' ? 'Hiding...' : 'Hide'}
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            disabled={pendingAction !== null || !canAccept}
                            onClick={() => onAccept(item)}
                            className="min-h-11 rounded-lg border border-emerald-700 bg-emerald-900/30 px-3 py-1.5 text-xs font-medium text-emerald-100 transition-colors hover:bg-emerald-900/45 disabled:cursor-not-allowed disabled:opacity-65"
                          >
                            {getFeedSuggestionAcceptLabel(item, pendingAction === 'accept')}
                          </button>
                          <button
                            type="button"
                            disabled={pendingAction !== null}
                            onClick={() => onDismiss(item)}
                            className="min-h-11 rounded-lg border border-zinc-700 bg-zinc-900/45 px-3 py-1.5 text-xs font-medium text-zinc-200 transition-colors hover:bg-zinc-900/70 disabled:cursor-not-allowed disabled:opacity-65"
                          >
                            {pendingAction === 'dismiss' ? 'Dismissing...' : 'Dismiss'}
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </article>
  );
}
