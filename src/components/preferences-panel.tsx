'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type SyntheticEvent } from 'react';
import { AUTH_REQUIRED_MESSAGE, isAuthFailure } from '@/lib/auth-failure';
import { useOverlayDismiss } from '@/lib/overlay-dismiss';

const PAGE_SIZE = 50;
const preferenceTabs = [
  { id: 'all', label: 'All' },
  { id: 'liked', label: 'Likes' },
  { id: 'disliked', label: 'Dislikes' },
  { id: 'hidden', label: 'Hidden' },
] as const;

type PreferenceFilterType = typeof preferenceTabs[number]['id'];

interface PreferenceStats {
  total: number;
  byType: Record<string, number>;
  bySource: Record<string, number>;
}

interface PreferenceListItem {
  id: string;
  feedItemId: string | null;
  signalType: string;
  source: string;
  text: string;
  reason: string | null;
  authorUsername: string | null;
  createdAt: string;
  feedTitle: string | null;
  feedText: string | null;
}

interface PreferencesResponse {
  items?: PreferenceListItem[];
  stats?: PreferenceStats;
  pagination?: {
    hasMore?: boolean;
  };
}

interface PreferencesPanelProps {
  open: boolean;
  onClose: () => void;
}

function formatTimestamp(timestamp: string): string {
  const value = new Date(timestamp);
  if (Number.isNaN(value.getTime())) return '';
  return value.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function getActionPill(signalType: string): { label: string; icon: string; className: string } {
  const normalized = signalType.trim().toLowerCase();
  if (normalized === 'liked' || normalized === 'bookmarked' || normalized === 'explicit') {
    return {
      label: 'Liked',
      icon: '👍',
      className: 'border-emerald-700/70 bg-emerald-900/30 text-emerald-200',
    };
  }
  if (normalized === 'disliked') {
    return {
      label: 'Disliked',
      icon: '👎',
      className: 'border-rose-700/70 bg-rose-900/30 text-rose-200',
    };
  }
  if (normalized === 'hidden') {
    return {
      label: 'Hidden',
      icon: '🙈',
      className: 'border-amber-700/70 bg-amber-900/30 text-amber-200',
    };
  }
  return {
    label: normalized || 'Preference',
    icon: '•',
    className: 'border-zinc-700 bg-zinc-900 text-zinc-200',
  };
}

function PreferenceReasonForm({
  reason,
  isSaving,
  onReasonChange,
  onSubmit,
  onCancel,
}: {
  reason: string;
  isSaving: boolean;
  onReasonChange: (nextReason: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const stopPropagation = (event: SyntheticEvent) => {
    event.stopPropagation();
  };

  return (
    <div
      className="mt-2 flex items-center gap-2"
      onClick={stopPropagation}
      onTouchStart={stopPropagation}
    >
      <input
        type="text"
        value={reason}
        onChange={(event) => onReasonChange(event.target.value)}
        placeholder="Add a reason (optional)"
        className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 placeholder-zinc-500 focus:border-zinc-500 focus:outline-none"
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Enter') {
            event.preventDefault();
            onSubmit();
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
        }}
        onClick={stopPropagation}
        onTouchStart={stopPropagation}
        onFocus={stopPropagation}
        autoFocus
      />
      <button
        type="button"
        disabled={isSaving}
        onClick={(event) => {
          event.stopPropagation();
          onSubmit();
        }}
        onTouchStart={stopPropagation}
        className="text-sm text-sky-400 transition-colors hover:text-sky-300 disabled:opacity-65"
      >
        {isSaving ? 'Saving...' : 'Done'}
      </button>
      <button
        type="button"
        disabled={isSaving}
        onClick={(event) => {
          event.stopPropagation();
          onCancel();
        }}
        onTouchStart={stopPropagation}
        className="text-sm text-zinc-500 transition-colors hover:text-zinc-400 disabled:opacity-65"
      >
        Cancel
      </button>
    </div>
  );
}

export function PreferencesPanel({ open, onClose }: PreferencesPanelProps) {
  const { backdropProps } = useOverlayDismiss({
    enabled: open,
    onClose,
  });
  const [items, setItems] = useState<PreferenceListItem[]>([]);
  const [stats, setStats] = useState<PreferenceStats | null>(null);
  const [activeFilter, setActiveFilter] = useState<PreferenceFilterType>('all');
  const [isLoadingInitial, setIsLoadingInitial] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [undoPendingId, setUndoPendingId] = useState<string | null>(null);
  const [undoConfirmId, setUndoConfirmId] = useState<string | null>(null);
  const [editingReasonId, setEditingReasonId] = useState<string | null>(null);
  const [reasonDraft, setReasonDraft] = useState('');
  const [reasonPendingId, setReasonPendingId] = useState<string | null>(null);

  const offsetRef = useRef(0);
  const isFetchingRef = useRef(false);
  const requestIdRef = useRef(0);
  const scrollRootRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const counts = useMemo(() => {
    if (!stats) {
      return {
        all: 0,
        liked: 0,
        disliked: 0,
        hidden: 0,
      };
    }

    return {
      all: stats.total ?? 0,
      liked: (stats.byType.liked ?? 0) + (stats.byType.bookmarked ?? 0) + (stats.byType.explicit ?? 0),
      disliked: stats.byType.disliked ?? 0,
      hidden: stats.byType.hidden ?? 0,
    };
  }, [stats]);

  const loadPage = useCallback(async (reset: boolean) => {
    if (!open || isFetchingRef.current) return;
    isFetchingRef.current = true;
    setError(null);

    const currentRequestId = requestIdRef.current + 1;
    requestIdRef.current = currentRequestId;

    const nextOffset = reset ? 0 : offsetRef.current;
    if (reset) {
      setIsLoadingInitial(true);
      setHasMore(true);
    } else {
      setIsLoadingMore(true);
    }

    try {
      const query = new URLSearchParams();
      query.set('offset', String(nextOffset));
      query.set('limit', String(PAGE_SIZE));
      query.set('type', activeFilter);

      const response = await fetch(`/api/preferences?${query.toString()}`, { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`Error ${response.status}`);
      }

      const payload = (await response.json()) as PreferencesResponse;
      if (requestIdRef.current !== currentRequestId) {
        return;
      }

      const incomingItems = Array.isArray(payload.items) ? payload.items : [];
      setItems((current) => {
        if (reset) {
          return incomingItems;
        }

        const seen = new Set(current.map((item) => item.id));
        const merged = [...current];
        for (const item of incomingItems) {
          if (seen.has(item.id)) continue;
          merged.push(item);
          seen.add(item.id);
        }
        return merged;
      });

      if (payload.stats) {
        setStats(payload.stats);
      }

      offsetRef.current = nextOffset + incomingItems.length;
      setHasMore(
        payload.pagination?.hasMore === true
        || (payload.pagination?.hasMore === undefined && incomingItems.length === PAGE_SIZE),
      );
    } catch {
      if (requestIdRef.current === currentRequestId) {
        setError('Failed to load preferences');
      }
    } finally {
      if (requestIdRef.current === currentRequestId) {
        setIsLoadingInitial(false);
        setIsLoadingMore(false);
      }
      isFetchingRef.current = false;
    }
  }, [activeFilter, open]);

  const loadMore = useCallback(() => {
    if (!open || isLoadingInitial || isLoadingMore || !hasMore) return;
    void loadPage(false);
  }, [hasMore, isLoadingInitial, isLoadingMore, loadPage, open]);

  const handleUndo = useCallback(async (item: PreferenceListItem) => {
    if (undoPendingId) return;

    if (undoConfirmId !== item.id) {
      setUndoConfirmId(item.id);
      return;
    }

    setUndoPendingId(item.id);
    setError(null);

    let response: Response | null = null;
    try {
      response = await fetch(`/api/preferences/${encodeURIComponent(item.id)}`, {
        method: 'DELETE',
      });
      if (!response.ok) {
        throw new Error(
          isAuthFailure(response, null) ? AUTH_REQUIRED_MESSAGE : `Error ${response.status}`,
        );
      }

      setItems((current) => current.filter((entry) => entry.id !== item.id));
      offsetRef.current = Math.max(0, offsetRef.current - 1);
      setStats((current) => {
        if (!current) return current;
        const nextByType = { ...current.byType };
        const nextTypeCount = Math.max(0, (nextByType[item.signalType] ?? 0) - 1);
        if (nextTypeCount === 0) {
          delete nextByType[item.signalType];
        } else {
          nextByType[item.signalType] = nextTypeCount;
        }
        return {
          ...current,
          total: Math.max(0, current.total - 1),
          byType: nextByType,
        };
      });
    } catch (error) {
      setError(isAuthFailure(response, error) ? AUTH_REQUIRED_MESSAGE : 'Undo failed');
    } finally {
      setUndoPendingId(null);
      setUndoConfirmId(null);
    }
  }, [undoConfirmId, undoPendingId]);

  const handleStartReasonEdit = useCallback((item: PreferenceListItem) => {
    if (reasonPendingId) return;
    setEditingReasonId(item.id);
    setReasonDraft(item.reason?.trim() ?? '');
    setError(null);
  }, [reasonPendingId]);

  const handleCancelReasonEdit = useCallback(() => {
    if (reasonPendingId) return;
    setEditingReasonId(null);
    setReasonDraft('');
  }, [reasonPendingId]);

  const handleSubmitReason = useCallback(async () => {
    if (!editingReasonId || reasonPendingId) return;

    const trimmedReason = reasonDraft.trim();
    setReasonPendingId(editingReasonId);
    setError(null);

    let response: Response | null = null;
    try {
      response = await fetch(`/api/preferences/${encodeURIComponent(editingReasonId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: trimmedReason }),
      });

      if (!response.ok) {
        throw new Error(
          isAuthFailure(response, null) ? AUTH_REQUIRED_MESSAGE : `Error ${response.status}`,
        );
      }

      const payload = await response.json() as { item?: { reason?: unknown } };
      const nextReason = typeof payload.item?.reason === 'string' ? payload.item.reason : (trimmedReason || null);

      setItems((current) => current.map((entry) => {
        if (entry.id !== editingReasonId) return entry;
        return {
          ...entry,
          reason: nextReason,
        };
      }));
      setEditingReasonId(null);
      setReasonDraft('');
    } catch (error) {
      setError(isAuthFailure(response, error) ? AUTH_REQUIRED_MESSAGE : 'Failed to save reason');
    } finally {
      setReasonPendingId(null);
    }
  }, [editingReasonId, reasonDraft, reasonPendingId]);

  useEffect(() => {
    if (!open) return;
    offsetRef.current = 0;
    setItems([]);
    setHasMore(true);
    setError(null);
    setUndoConfirmId(null);
    setEditingReasonId(null);
    setReasonDraft('');
    setReasonPendingId(null);
    void loadPage(true);
  }, [activeFilter, loadPage, open]);

  useEffect(() => {
    if (!undoConfirmId) return;
    const timeout = window.setTimeout(() => setUndoConfirmId(null), 4000);
    return () => window.clearTimeout(timeout);
  }, [undoConfirmId]);

  useEffect(() => {
    if (!open) return;
    const root = scrollRootRef.current;
    const sentinel = sentinelRef.current;
    if (!root || !sentinel) return;

    const observer = new IntersectionObserver((entries) => {
      if (!entries[0]?.isIntersecting) return;
      loadMore();
    }, {
      root,
      rootMargin: '260px 0px',
    });

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadMore, open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-end bg-black/55 sm:items-stretch">
      <div
        aria-hidden="true"
        className="absolute inset-0"
        {...backdropProps}
      />
      <aside
        data-testid="preferences-panel"
        className="relative flex h-[100dvh] w-full max-w-2xl flex-col border-l border-zinc-800 bg-zinc-950 shadow-2xl max-sm:rounded-none max-sm:border-l-0 max-sm:border-t max-sm:pt-[env(safe-area-inset-top)] max-sm:pb-[env(safe-area-inset-bottom)]"
      >
        <div className="border-b border-zinc-800 px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-zinc-100">Preferences</h2>
              <p className="text-xs text-zinc-500">{counts.all.toLocaleString()} total signals</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="min-h-11 rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-200 hover:bg-zinc-900"
            >
              Close
            </button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {preferenceTabs.map((tab) => {
              const selected = activeFilter === tab.id;
              const count = counts[tab.id];
              return (
                <button
                  key={tab.id}
                  type="button"
                  data-testid={`preferences-filter-${tab.id}`}
                  onClick={() => setActiveFilter(tab.id)}
                  className={`min-h-10 rounded-full border px-3 py-1 text-xs transition-colors ${
                    selected
                      ? 'border-sky-600 bg-sky-900/30 text-sky-200'
                      : 'border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800'
                  }`}
                >
                  {tab.label} ({count.toLocaleString()})
                </button>
              );
            })}
          </div>
        </div>

        {error && (
          <p className="border-b border-rose-800/70 bg-rose-950/30 px-4 py-2 text-xs text-rose-200">{error}</p>
        )}

        <div ref={scrollRootRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3 sm:px-4">
          {isLoadingInitial && (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 text-sm text-zinc-400">
              Loading preferences...
            </div>
          )}

          {!isLoadingInitial && items.length === 0 && (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 text-sm text-zinc-400">
              No preferences yet for this filter.
            </div>
          )}

          <div className="space-y-2">
            {items.map((item) => {
              const displayText = item.feedTitle || item.feedText || item.text || 'Untitled item';
              const action = getActionPill(item.signalType);
              const isPendingUndo = undoPendingId === item.id;
              const needsConfirm = undoConfirmId === item.id;
              const hasReason = typeof item.reason === 'string' && item.reason.trim().length > 0;
              const isEditingReason = editingReasonId === item.id;
              const isSavingReason = reasonPendingId === item.id;
              const reasonEditDisabled = reasonPendingId !== null && reasonPendingId !== item.id;

              return (
                <article key={item.id} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${action.className}`}>
                      <span aria-hidden="true">{action.icon}</span>
                      {action.label}
                    </span>
                    <time className="text-[11px] text-zinc-500">{formatTimestamp(item.createdAt)}</time>
                  </div>

                  <p className="mt-2 line-clamp-2 text-sm text-zinc-100">{displayText}</p>

                  {!isEditingReason && hasReason && (
                    <div className="mt-2 flex items-start justify-between gap-2">
                      <p className="min-w-0 flex-1 rounded-lg border border-zinc-800 bg-black/30 px-2 py-1.5 text-xs text-zinc-300">
                        Reason: {item.reason}
                      </p>
                      <button
                        type="button"
                        disabled={reasonEditDisabled}
                        onClick={(event) => {
                          event.stopPropagation();
                          handleStartReasonEdit(item);
                        }}
                        onTouchStart={(event) => event.stopPropagation()}
                        className="shrink-0 pt-1 text-xs text-zinc-400 transition-colors hover:text-zinc-300 hover:underline disabled:no-underline disabled:opacity-65"
                      >
                        Edit
                      </button>
                    </div>
                  )}

                  {!isEditingReason && !hasReason && (
                    <button
                      type="button"
                      disabled={reasonEditDisabled}
                      onClick={(event) => {
                        event.stopPropagation();
                        handleStartReasonEdit(item);
                      }}
                      onTouchStart={(event) => event.stopPropagation()}
                      className="mt-2 text-xs text-zinc-400 transition-colors hover:text-zinc-300 hover:underline disabled:no-underline disabled:opacity-65"
                    >
                      Add reason
                    </button>
                  )}

                  {isEditingReason && (
                    <PreferenceReasonForm
                      reason={reasonDraft}
                      isSaving={isSavingReason}
                      onReasonChange={setReasonDraft}
                      onSubmit={() => {
                        void handleSubmitReason();
                      }}
                      onCancel={handleCancelReasonEdit}
                    />
                  )}

                  <div className="mt-2 flex items-center justify-between gap-2">
                    <p className="truncate text-[11px] text-zinc-500">
                      {item.authorUsername ? `@${item.authorUsername}` : item.source}
                    </p>
                    <button
                      type="button"
                      disabled={isPendingUndo}
                      onClick={() => {
                        void handleUndo(item);
                      }}
                      className={`min-h-10 rounded-md border px-2.5 py-1 text-xs transition-colors disabled:opacity-70 ${
                        needsConfirm
                          ? 'border-rose-500 bg-rose-900/40 text-rose-100 hover:bg-rose-900/55'
                          : 'border-zinc-700 bg-zinc-800 text-zinc-200 hover:bg-zinc-700'
                      }`}
                    >
                      {isPendingUndo ? 'Undoing...' : needsConfirm ? 'Confirm Undo' : 'Undo'}
                    </button>
                  </div>
                </article>
              );
            })}
          </div>

          {isLoadingMore && (
            <p className="py-3 text-center text-xs text-zinc-500">Loading more...</p>
          )}
          <div ref={sentinelRef} className="h-6" />
        </div>
      </aside>
    </div>
  );
}
