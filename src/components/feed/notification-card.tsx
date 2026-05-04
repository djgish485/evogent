'use client';

import { formatCompactTimestamp, getFeedItemCompactTimestampSource } from '@/lib/compact-timestamp';
import { splitSearchHighlightParts } from '@/lib/search-utils';
import type { FeedItem, NotificationSeverity, NotificationTaskContext } from '@/types/feed';

interface NotificationCardProps {
  item: FeedItem;
  pendingAction: 'dismiss' | null;
  feedback?: string | null;
  onDismiss: (item: FeedItem) => void;
  showTaskContext?: boolean;
  searchQuery?: string | null;
}

function HighlightedSearchText({ text, searchQuery }: { text: string; searchQuery?: string | null }) {
  const parts = splitSearchHighlightParts(text, searchQuery);

  return (
    <>
      {parts.map((part, index) => part.isMatch ? (
        <span
          key={`${index}-${part.text}`}
          data-search-highlight="true"
          className="search-match rounded bg-amber-400/20 px-0.5 text-amber-100"
        >
          {part.text}
        </span>
      ) : (
        <span key={`${index}-${part.text}`}>{part.text}</span>
      ))}
    </>
  );
}

function getSeverity(item: FeedItem): NotificationSeverity {
  const severity = item.metadata?.severity;
  if (severity === 'warning' || severity === 'error') {
    return severity;
  }
  return 'info';
}

function getSeverityLabel(severity: NotificationSeverity): string {
  switch (severity) {
    case 'warning':
      return 'Warning';
    case 'error':
      return 'Error';
    default:
      return 'Info';
  }
}

function getSeverityClasses(severity: NotificationSeverity): { tint: string; badge: string; icon: string } {
  switch (severity) {
    case 'warning':
      return {
        tint: 'bg-amber-950/10',
        badge: 'border-amber-500/70 bg-amber-500/10 text-amber-100',
        icon: 'text-amber-300',
      };
    case 'error':
      return {
        tint: 'bg-red-950/10',
        badge: 'border-red-500/70 bg-red-500/10 text-red-100',
        icon: 'text-red-300',
      };
    default:
      return {
        tint: 'bg-sky-950/10',
        badge: 'border-sky-500/70 bg-sky-500/10 text-sky-100',
        icon: 'text-sky-300',
      };
  }
}

function NotificationIcon({ severity }: { severity: NotificationSeverity }) {
  if (severity === 'warning') {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true" className="h-4 w-4 fill-current">
        <path d="M10 2.5 18 17H2L10 2.5Zm0 4.2a1 1 0 0 0-1 1v4.1a1 1 0 1 0 2 0V7.7a1 1 0 0 0-1-1Zm0 8.3a1.15 1.15 0 1 0 0-2.3 1.15 1.15 0 0 0 0 2.3Z" />
      </svg>
    );
  }

  if (severity === 'error') {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true" className="h-4 w-4 fill-current">
        <path d="M10 1.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17Zm-2.8 5.7a1 1 0 0 0 0 1.4L8.6 10l-1.4 1.4a1 1 0 1 0 1.4 1.4l1.4-1.4 1.4 1.4a1 1 0 1 0 1.4-1.4L11.4 10l1.4-1.4a1 1 0 1 0-1.4-1.4L10 8.6 8.6 7.2a1 1 0 0 0-1.4 0Z" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" className="h-4 w-4 fill-current">
      <path d="M10 1.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17Zm0 4.1a1 1 0 0 0-1 1v.1a1 1 0 0 0 2 0v-.1a1 1 0 0 0-1-1Zm1 3.4H8.9a1 1 0 0 0 0 2H9v3.2a1 1 0 0 0 2 0V9Z" />
    </svg>
  );
}

function getTaskStateLabel(state: NotificationTaskContext['state']): string | null {
  switch (state) {
    case 'queued':
      return 'Queued';
    case 'processing':
      return 'Running';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    default:
      return null;
  }
}

export function NotificationCard({
  item,
  pendingAction,
  feedback,
  onDismiss,
  showTaskContext = false,
  searchQuery = null,
}: NotificationCardProps) {
  const severity = getSeverity(item);
  const classes = getSeverityClasses(severity);
  const title = item.title?.trim() || 'Notification';
  const dismissable = item.metadata?.dismissable !== false;
  const notificationTimestamp = getFeedItemCompactTimestampSource(item);
  const notificationTimestampLabel = formatCompactTimestamp(notificationTimestamp);
  const taskContext = showTaskContext ? item.notificationTaskContext ?? null : null;
  const taskUpdatedAtLabel = formatCompactTimestamp(taskContext?.updatedAt ?? null);
  const taskStateLabel = getTaskStateLabel(taskContext?.state ?? null);

  return (
    <article
      data-testid="notification-card"
      data-item-type="notification"
      data-item-id={item.id}
      data-feed-item-id={item.id}
      data-feed-item-type={item.type}
      className="group relative w-full overflow-hidden rounded-2xl border border-zinc-800/80 bg-zinc-950/90 px-4 py-3 shadow-[0_12px_36px_rgba(0,0,0,0.18)] transition-[background-color,border-color,box-shadow] hover:border-zinc-700/80 hover:bg-zinc-950 hover:shadow-[0_18px_44px_rgba(0,0,0,0.24)]"
    >
      <div className={`pointer-events-none absolute inset-0 ${classes.tint}`} />
      <div className="relative flex items-start gap-3">
        <div className={`mt-0.5 shrink-0 ${classes.icon}`}>
          <NotificationIcon severity={severity} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${classes.badge}`}>
                  {getSeverityLabel(severity)}
                </span>
                <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-zinc-100">
                  <HighlightedSearchText text={title} searchQuery={searchQuery} />
                </h3>
                {notificationTimestampLabel ? (
                  <time
                    dateTime={notificationTimestamp ?? undefined}
                    className="shrink-0 text-[11px] text-zinc-500"
                  >
                    {notificationTimestampLabel}
                  </time>
                ) : null}
              </div>
              <p className="mt-1 text-sm leading-relaxed text-zinc-200">
                <HighlightedSearchText text={item.text} searchQuery={searchQuery} />
              </p>
              {item.excerpt && (
                <p className="mt-1 text-xs text-zinc-400">
                  <HighlightedSearchText text={item.excerpt} searchQuery={searchQuery} />
                </p>
              )}
              {taskContext && (taskContext.summary || taskContext.lines.length > 0) ? (
                <div className="mt-2 rounded-xl border border-zinc-800/80 bg-black/25 px-3 py-2">
                  <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-500">
                    <span className="font-medium text-zinc-300">Task {taskContext.taskId}</span>
                    {taskStateLabel ? (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>{taskStateLabel}</span>
                      </>
                    ) : null}
                    {taskUpdatedAtLabel ? (
                      <>
                        <span aria-hidden="true">·</span>
                        <time dateTime={taskContext.updatedAt ?? undefined}>{taskUpdatedAtLabel}</time>
                      </>
                    ) : null}
                  </div>
                  {taskContext.summary ? (
                    <p className="mt-1 text-xs leading-relaxed text-zinc-300">
                      <HighlightedSearchText text={taskContext.summary} searchQuery={searchQuery} />
                    </p>
                  ) : null}
                  {taskContext.lines.length > 0 ? (
                    <div className="mt-2 space-y-1">
                      {taskContext.lines.map((line, index) => (
                        <p key={`${taskContext.taskId}:${index}`} className="text-xs leading-relaxed text-zinc-400">
                          <HighlightedSearchText text={line} searchQuery={searchQuery} />
                        </p>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
              {feedback && (
                <p className={`mt-2 text-xs ${feedback.toLowerCase().includes('failed') ? 'text-red-300' : 'text-zinc-400'}`}>
                  {feedback}
                </p>
              )}
            </div>
            {dismissable && (
              <button
                type="button"
                data-testid="notification-dismiss-button"
                disabled={pendingAction !== null}
                onClick={() => onDismiss(item)}
                aria-label="Dismiss notification"
                className="rounded-md border border-zinc-700 bg-black/20 px-2 py-1 text-xs text-zinc-300 transition-colors hover:bg-black/35 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {pendingAction === 'dismiss' ? '...' : 'X'}
              </button>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}
