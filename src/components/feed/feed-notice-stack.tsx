'use client';

interface FeedNoticeStackProps {
  headerOffsetPx: number;
  pendingItemCount: number;
  reorganizedItemCount: number | null;
  searchQuery: string | null;
  onRevealPendingItems: () => void;
  onShowArrangedFeedOrder: () => void;
  onClearSearch: () => void;
}

/**
 * Keep live feed notices in one sticky lane. New-item and reordered-item actions are separate
 * decisions, but they must never become overlapping tap targets on a phone-sized launcher.
 */
export function FeedNoticeStack({
  headerOffsetPx,
  pendingItemCount,
  reorganizedItemCount,
  searchQuery,
  onRevealPendingItems,
  onShowArrangedFeedOrder,
  onClearSearch,
}: FeedNoticeStackProps) {
  if (pendingItemCount <= 0 && reorganizedItemCount === null && !searchQuery) {
    return null;
  }

  return (
    <div
      data-testid="feed-notice-stack"
      className="sticky z-40 flex w-full min-w-0 flex-col items-stretch gap-2"
      style={{ top: `${headerOffsetPx}px` }}
    >
      {pendingItemCount > 0 ? (
        <div className="flex w-full justify-center">
          <button
            type="button"
            data-testid="new-posts-button"
            onClick={onRevealPendingItems}
            className="max-w-full rounded-full border border-blue-400/40 bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-lg transition hover:bg-blue-500 active:bg-blue-700"
          >
            {pendingItemCount} new post{pendingItemCount === 1 ? '' : 's'}
          </button>
        </div>
      ) : null}

      {reorganizedItemCount !== null ? (
        <div
          data-testid="feed-reorder-banner"
          className="flex w-full min-w-0 flex-wrap items-center justify-between gap-3 rounded-xl border border-teal-500/25 bg-zinc-950 px-4 py-3 shadow-[0_8px_20px_rgba(0,0,0,0.24)]"
        >
          <p className="min-w-0 text-sm text-zinc-200">
            {reorganizedItemCount} item{reorganizedItemCount === 1 ? '' : 's'} reorganized
          </p>
          <button
            type="button"
            onClick={onShowArrangedFeedOrder}
            className="shrink-0 rounded-full border border-teal-400/35 bg-teal-500/15 px-3 py-1.5 text-xs font-medium text-teal-100 transition hover:border-teal-300/55 hover:bg-teal-500/25"
          >
            Show new order
          </button>
        </div>
      ) : null}

      {searchQuery ? (
        <div
          data-testid="active-search-banner"
          className="w-full min-w-0 rounded-xl border border-sky-500/20 bg-zinc-950 px-4 py-3 shadow-[0_8px_20px_rgba(0,0,0,0.24)]"
        >
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium uppercase tracking-[0.18em] text-sky-200/80">Search</p>
              <p className="mt-1 break-words text-sm text-zinc-100">
                Results for “{searchQuery}” across saved feed content and stored detail items.
              </p>
            </div>
            <button
              type="button"
              onClick={onClearSearch}
              className="inline-flex shrink-0 items-center justify-center rounded-full border border-sky-400/35 bg-sky-500/12 px-3 py-1.5 text-xs font-medium text-sky-100 transition hover:border-sky-300/55 hover:bg-sky-500/20"
              aria-label="Clear active search"
            >
              Clear
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
