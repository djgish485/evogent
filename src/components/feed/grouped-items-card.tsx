'use client';

import type { CSSProperties } from 'react';

import {
  getFeedSuggestionDefaultTitle,
  getSuggestionStatusLabel,
} from '@/lib/feed-suggestions';
import { formatCompactTimestamp, getFeedItemCompactTimestampSource } from '@/lib/compact-timestamp';
import type { FeedItem, NotificationSeverity, SuggestionStatus } from '@/types/feed';

export type GroupType = 'suggestion' | 'notification';

export interface StatusCounts {
  pending: number;
  dispatched: number;
  running: number;
  merged: number;
  failed: number;
  accepted: number;
}

export interface GroupedItemFeedback {
  id: string;
  label: string;
  message: string;
  tone: 'error' | 'success';
}

export interface GroupedItemsCardProps {
  groupId: string;
  groupType: GroupType;
  title: string;
  summary: string;
  items?: FeedItem[];
  previewItems?: FeedItem[];
  itemCount: number;
  timestamp?: string | null;
  statusCounts?: StatusCounts | null;
  feedbackItems?: GroupedItemFeedback[];
  onOpenDetail: () => void;
  resolveSuggestionStatus?: (item: FeedItem) => SuggestionStatus;
  getSuggestionPendingAction?: (item: FeedItem) => 'accept' | 'dismiss' | null;
  getSuggestionFeedback?: (item: FeedItem) => string | null | undefined;
  onSuggestionAccept?: (item: FeedItem) => void;
  onSuggestionDismiss?: (item: FeedItem) => void;
  onSuggestionChat?: (item: FeedItem) => void;
  chatAction?: { label: string; disabled: boolean; onClick: () => void };
  batchActions?: {
    acceptAll?: { label: string; disabled: boolean; onClick: () => void };
    dismissAll?: { label: string; disabled: boolean; onClick: () => void };
  };
}

const OLED_MIN_VISIBLE_CHANNEL_DELTA = 5;

type RgbColor = readonly [number, number, number];

function rgb(color: RgbColor): string {
  return `rgb(${color[0]} ${color[1]} ${color[2]})`;
}

function ensureVisibleOnOled(color: RgbColor, label: string): string {
  if (color.some((channel) => channel < OLED_MIN_VISIBLE_CHANNEL_DELTA)) {
    throw new Error(`${label} is too close to #000000 for OLED surfaces`);
  }
  return rgb(color);
}

function buildCardSurfaceStyle(
  backgroundColor: RgbColor,
  hoverBackgroundColor: RgbColor,
  label: string,
): CSSProperties {
  return {
    ['--grouped-card-bg' as string]: ensureVisibleOnOled(backgroundColor, `${label} background`),
    ['--grouped-card-bg-hover' as string]: ensureVisibleOnOled(hoverBackgroundColor, `${label} hover background`),
  };
}

function getGroupStyles(groupType: GroupType): {
  surfaceStyle: CSSProperties;
  labelText: string;
  singularLabel: string;
  pluralLabel: string;
  avatarClassName: string;
  previewBadgeClassName: string;
  previewRowClassName: string;
} {
  switch (groupType) {
    case 'suggestion':
      return {
        surfaceStyle: buildCardSurfaceStyle([38, 24, 8], [46, 28, 10], 'Suggestion grouped card'),
        labelText: 'Suggestions',
        singularLabel: 'suggestion',
        pluralLabel: 'suggestions',
        avatarClassName: 'border-amber-700/70 bg-amber-950/55 text-amber-100',
        previewBadgeClassName: 'text-amber-300/90',
        previewRowClassName: 'border-amber-900/40 bg-black/25',
      };
    case 'notification':
      return {
        surfaceStyle: buildCardSurfaceStyle([9, 24, 35], [11, 28, 40], 'Notification grouped card'),
        labelText: 'Notifications',
        singularLabel: 'notification',
        pluralLabel: 'notifications',
        avatarClassName: 'border-sky-700/70 bg-sky-950/55 text-sky-100',
        previewBadgeClassName: 'text-sky-300/90',
        previewRowClassName: 'border-sky-900/40 bg-black/25',
      };
  }
}

function getGroupHeaderMeta(
  groupType: GroupType,
  itemCount: number,
  labelText: string,
  singularLabel: string,
  pluralLabel: string,
  statusCounts?: StatusCounts | null,
): {
  primary: string;
  secondary: string | null;
} {
  if (groupType === 'suggestion') {
    if (statusCounts) {
      const inProgressCount = statusCounts.running + statusCounts.dispatched;
      if (statusCounts.pending > 0) return { primary: `${statusCounts.pending} pending`, secondary: null };
      if (statusCounts.failed > 0) return { primary: `${statusCounts.failed} failed`, secondary: null };
      if (inProgressCount > 0) return { primary: `${inProgressCount} in progress`, secondary: null };
      return { primary: `${itemCount} recent`, secondary: null };
    }

    return {
      primary: `${itemCount} ${itemCount === 1 ? singularLabel : pluralLabel}`,
      secondary: null,
    };
  }

  return {
    primary: 'Evogent',
    secondary: labelText,
  };
}

function SuggestionGroupIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" className="h-5 w-5 fill-current">
      <path d="M10 1.75a5.75 5.75 0 0 0-3.9 9.97c.5.46.89.9 1.13 1.38.18.35.3.72.36 1.1h4.82c.06-.38.18-.75.36-1.1.24-.48.63-.92 1.13-1.38A5.75 5.75 0 0 0 10 1.75Zm-1.9 14.5a.9.9 0 0 1 .9-.9h2a.9.9 0 1 1 0 1.8H9a.9.9 0 0 1-.9-.9Zm1.2 1.95a.7.7 0 0 1 .7-.7h.1a.7.7 0 0 1 .7.7.95.95 0 0 1-1.9 0Z" />
    </svg>
  );
}

function NotificationGroupIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" className="h-5 w-5 fill-current">
      <path d="M10 2.25a4.25 4.25 0 0 0-4.25 4.25v1.22c0 .8-.24 1.58-.68 2.25l-.94 1.42a1.5 1.5 0 0 0 1.25 2.33h9.24a1.5 1.5 0 0 0 1.25-2.33l-.94-1.42a4.06 4.06 0 0 1-.68-2.25V6.5A4.25 4.25 0 0 0 10 2.25Zm-1.86 13.7a1.86 1.86 0 0 0 3.72 0H8.14Z" />
    </svg>
  );
}

function GroupAvatar({ groupType, className }: { groupType: GroupType; className: string }) {
  return (
    <div className={`flex h-11 w-11 items-center justify-center rounded-full border sm:h-12 sm:w-12 ${className}`}>
      {groupType === 'suggestion' ? <SuggestionGroupIcon /> : <NotificationGroupIcon />}
    </div>
  );
}

function StatusIndicators({ counts }: { counts: StatusCounts }) {
  const parts: Array<{ label: string; dotClass: string; count: number }> = [];
  if (counts.failed > 0) parts.push({ label: 'failed', dotClass: 'bg-red-400', count: counts.failed });
  if (counts.running > 0 || counts.dispatched > 0) parts.push({ label: 'in progress', dotClass: 'bg-amber-400 animate-pulse', count: counts.running + counts.dispatched });
  if (counts.merged > 0) parts.push({ label: 'merged', dotClass: 'bg-emerald-400', count: counts.merged });
  if (counts.accepted > 0) parts.push({ label: 'accepted', dotClass: 'bg-emerald-400', count: counts.accepted });
  if (counts.pending > 0) parts.push({ label: 'pending', dotClass: 'bg-zinc-400', count: counts.pending });

  if (parts.length === 0) return null;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
      {parts.map((p) => (
        <span key={p.label} className="flex items-center gap-1.5 text-[11px] text-zinc-400">
          <span className={`inline-block h-2 w-2 rounded-full ${p.dotClass}`} />
          {p.count} {p.label}
        </span>
      ))}
    </div>
  );
}

interface CompactPreviewItem {
  id: string;
  title: string;
  meta: string;
  dotClassName: string;
  timestamp: string | null;
  timestampLabel: string;
}

const NOTIFICATION_PREVIEW_LIMIT = 4;
const SUGGESTION_PREVIEW_LIMIT = 4;
const SUGGESTION_RECENT_FALLBACK_LIMIT = 3;

function getNotificationSeverity(item: FeedItem): NotificationSeverity {
  const severity = item.metadata?.severity;
  if (severity === 'warning' || severity === 'error') {
    return severity;
  }
  return 'info';
}

function getSuggestionPreviewStatus(status: SuggestionStatus): Pick<CompactPreviewItem, 'meta' | 'dotClassName'> {
  if (status === 'failed') {
    return { meta: getSuggestionStatusLabel(status), dotClassName: 'bg-red-400' };
  }
  if (status === 'running' || status === 'dispatched') {
    return { meta: getSuggestionStatusLabel(status), dotClassName: 'bg-amber-400 animate-pulse' };
  }
  if (status === 'merged' || status === 'accepted') {
    return { meta: getSuggestionStatusLabel(status), dotClassName: 'bg-emerald-400' };
  }
  if (status === 'dismissed') {
    return { meta: getSuggestionStatusLabel(status), dotClassName: 'bg-zinc-500' };
  }

  return { meta: getSuggestionStatusLabel(status), dotClassName: 'bg-zinc-400' };
}

function getNotificationPreviewStatus(severity: NotificationSeverity): Pick<CompactPreviewItem, 'meta' | 'dotClassName'> {
  switch (severity) {
    case 'warning':
      return { meta: 'Warning', dotClassName: 'bg-amber-400' };
    case 'error':
      return { meta: 'Error', dotClassName: 'bg-red-400' };
    default:
      return { meta: 'Info', dotClassName: 'bg-sky-400' };
  }
}

function normalizePreviewTitle(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function resolvePreviewSuggestionStatus(
  item: FeedItem,
  resolveSuggestionStatus?: (item: FeedItem) => SuggestionStatus,
): SuggestionStatus {
  return resolveSuggestionStatus ? resolveSuggestionStatus(item) : (item.suggestionStatus ?? 'pending');
}

function isActiveSuggestionStatus(status: SuggestionStatus): boolean {
  return status === 'pending' || status === 'running' || status === 'dispatched' || status === 'failed';
}

function getSuggestionPreviewItems(
  items: FeedItem[],
  resolveSuggestionStatus?: (item: FeedItem) => SuggestionStatus,
): {
  hiddenCount: number;
  visibleItems: CompactPreviewItem[];
} {
  const pendingItems: FeedItem[] = [];
  const otherActiveItems: FeedItem[] = [];
  const completedItems: FeedItem[] = [];

  for (const item of items) {
    const status = resolvePreviewSuggestionStatus(item, resolveSuggestionStatus);
    if (status === 'pending') {
      pendingItems.push(item);
      continue;
    }
    if (isActiveSuggestionStatus(status)) {
      otherActiveItems.push(item);
      continue;
    }
    completedItems.push(item);
  }

  const activeItems = [...pendingItems, ...otherActiveItems];
  const visibleSourceItems = activeItems.length > 0
    ? activeItems.slice(0, SUGGESTION_PREVIEW_LIMIT)
    : completedItems.slice(0, SUGGESTION_RECENT_FALLBACK_LIMIT);

  return {
    hiddenCount: Math.max(activeItems.length - SUGGESTION_PREVIEW_LIMIT, 0),
    visibleItems: visibleSourceItems.map((item) => buildCompactPreviewItem(item, 'suggestion', resolveSuggestionStatus)),
  };
}

function renderGroupActionBar(
  batchActions: GroupedItemsCardProps['batchActions'],
  chatAction: GroupedItemsCardProps['chatAction'],
) {
  if (!batchActions && !chatAction) {
    return null;
  }

  return (
    <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-zinc-800/80 pt-3">
      {chatAction ? (
        <button
          type="button"
          data-testid="grouped-items-chat"
          disabled={chatAction.disabled}
          onClick={chatAction.onClick}
          className="min-h-11 flex-1 rounded-full border border-zinc-700 bg-zinc-900/45 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:bg-zinc-900/70 disabled:cursor-not-allowed disabled:opacity-65 sm:flex-none"
        >
          {chatAction.label}
        </button>
      ) : null}
      {batchActions?.acceptAll ? (
        <button
          type="button"
          data-testid="grouped-items-accept-all"
          disabled={batchActions.acceptAll.disabled}
          onClick={batchActions.acceptAll.onClick}
          className="min-h-11 flex-1 rounded-full border border-emerald-700 bg-emerald-900/30 px-4 py-2 text-sm font-medium text-emerald-100 transition-colors hover:bg-emerald-900/45 disabled:cursor-not-allowed disabled:opacity-65 sm:flex-none"
        >
          {batchActions.acceptAll.label}
        </button>
      ) : null}
      {batchActions?.dismissAll ? (
        <button
          type="button"
          data-testid="grouped-items-dismiss-all"
          disabled={batchActions.dismissAll.disabled}
          onClick={batchActions.dismissAll.onClick}
          className="min-h-11 flex-1 rounded-full border border-zinc-700 bg-zinc-900/45 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:bg-zinc-900/70 disabled:cursor-not-allowed disabled:opacity-65 sm:flex-none"
        >
          {batchActions.dismissAll.label}
        </button>
      ) : null}
    </div>
  );
}

function buildCompactPreviewItem(
  item: FeedItem,
  groupType: GroupType,
  resolveSuggestionStatus?: (item: FeedItem) => SuggestionStatus,
): CompactPreviewItem {
  if (groupType === 'suggestion') {
    const status = resolveSuggestionStatus ? resolveSuggestionStatus(item) : (item.suggestionStatus ?? 'pending');
    const title = normalizePreviewTitle(item.title || item.text || getFeedSuggestionDefaultTitle(item)) || getFeedSuggestionDefaultTitle(item);
    return {
      id: item.id,
      title,
      timestamp: null,
      timestampLabel: '',
      ...getSuggestionPreviewStatus(status),
    };
  }

  const severity = getNotificationSeverity(item);
  const title = normalizePreviewTitle(item.title || item.text || 'Notification') || 'Notification';
  const timestamp = getFeedItemCompactTimestampSource(item);
  return {
    id: item.id,
    title,
    timestamp,
    timestampLabel: formatCompactTimestamp(timestamp),
    ...getNotificationPreviewStatus(severity),
  };
}

export function GroupedItemsCard({
  groupId,
  groupType,
  title,
  summary,
  items = [],
  previewItems,
  itemCount,
  timestamp,
  statusCounts,
  feedbackItems = [],
  onOpenDetail,
  resolveSuggestionStatus,
  chatAction,
  batchActions,
}: GroupedItemsCardProps) {
  const styles = getGroupStyles(groupType);
  const previewSourceItems = previewItems ?? items;
  const visiblePreviewItems = previewSourceItems
    .slice(0, NOTIFICATION_PREVIEW_LIMIT)
    .map((item) => buildCompactPreviewItem(item, groupType, resolveSuggestionStatus));
  const hiddenPreviewCount = Math.max(itemCount - visiblePreviewItems.length, 0);
  const suggestionPreview = groupType === 'suggestion'
    ? getSuggestionPreviewItems(items, resolveSuggestionStatus)
    : null;
  const itemLabel = itemCount === 1 ? styles.singularLabel : styles.pluralLabel;
  const normalizedTitle = title.trim();
  const shouldShowTitle = normalizedTitle && normalizedTitle !== styles.labelText;
  const headline = shouldShowTitle ? normalizedTitle : `${itemCount} ${itemLabel}`;
  const headerMeta = getGroupHeaderMeta(groupType, itemCount, styles.labelText, styles.singularLabel, styles.pluralLabel, statusCounts);
  const relativeTimestamp = formatCompactTimestamp(timestamp);

  if (groupType === 'notification') {
    return (
      <article
        data-testid="grouped-items-card"
        data-group-id={groupId}
        data-group-type={groupType}
        className="group relative w-full overflow-hidden rounded-2xl border border-zinc-800/80 bg-[var(--grouped-card-bg)] p-4 shadow-[0_12px_36px_rgba(0,0,0,0.18)] transition-[background-color,border-color,box-shadow] hover:border-zinc-700/80 hover:bg-[var(--grouped-card-bg-hover)] hover:shadow-[0_18px_44px_rgba(0,0,0,0.24)]"
        style={styles.surfaceStyle}
      >
        <div className="relative">
          <button
            type="button"
            data-testid="grouped-items-open-detail"
            onClick={onOpenDetail}
            className="block w-full rounded-xl text-left transition-colors hover:bg-black/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/70"
            aria-label={`${itemCount} ${itemLabel}`}
          >
            <div className="space-y-2">
              {visiblePreviewItems.map((item) => (
                <div
                  key={item.id}
                  className={`flex items-center gap-2.5 rounded-xl border px-3 py-2 text-sm ${styles.previewRowClassName}`}
                >
                  <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${item.dotClassName}`} />
                  <span className="min-w-0 flex-1 truncate text-zinc-200">{item.title}</span>
                  <div className="flex shrink-0 items-center gap-1.5 text-[11px] text-zinc-500">
                    <span>{item.meta}</span>
                    {item.timestampLabel ? (
                      <>
                        <span aria-hidden="true">·</span>
                        <time dateTime={item.timestamp ?? undefined}>{item.timestampLabel}</time>
                      </>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
            {hiddenPreviewCount > 0 ? (
              <p className="mt-2 text-xs text-zinc-500">+{hiddenPreviewCount} more</p>
            ) : null}
          </button>
        </div>
      </article>
    );
  }

  return (
    <article
      data-testid="grouped-items-card"
      data-group-id={groupId}
      data-group-type={groupType}
      className="group relative w-full overflow-hidden rounded-2xl border border-zinc-800/80 bg-[var(--grouped-card-bg)] p-4 shadow-[0_12px_36px_rgba(0,0,0,0.18)] transition-[background-color,border-color,box-shadow] hover:border-zinc-700/80 hover:bg-[var(--grouped-card-bg-hover)] hover:shadow-[0_18px_44px_rgba(0,0,0,0.24)]"
      style={styles.surfaceStyle}
    >
      <div className="relative">
        <button
          type="button"
          data-testid="grouped-items-open-detail"
          onClick={onOpenDetail}
          className="block w-full rounded-xl text-left transition-colors hover:bg-black/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/70"
        >
          <div className="flex items-start gap-3">
            <div className="shrink-0">
              <GroupAvatar groupType={groupType} className={styles.avatarClassName} />
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-1.5 overflow-hidden text-[15px]">
                <p className="truncate font-semibold text-zinc-100">{headerMeta.primary}</p>
                {headerMeta.secondary ? (
                  <>
                    <span className="shrink-0 text-zinc-500">·</span>
                    <p className="truncate text-zinc-500">{headerMeta.secondary}</p>
                  </>
                ) : null}
                {relativeTimestamp ? (
                  <>
                    <span className="shrink-0 text-zinc-500">·</span>
                    <p className="shrink-0 text-zinc-500">{relativeTimestamp}</p>
                  </>
                ) : null}
              </div>

              {groupType !== 'suggestion' ? (
                <h3 className="mt-1 text-sm font-semibold leading-5 text-zinc-100">{headline}</h3>
              ) : null}
              {shouldShowTitle && groupType !== 'suggestion' ? (
                <p className={`mt-1 text-xs font-medium uppercase tracking-wide ${styles.previewBadgeClassName}`}>
                  {itemCount} {itemLabel}
                </p>
              ) : null}
              {groupType === 'suggestion' && suggestionPreview && suggestionPreview.visibleItems.length > 0 ? (
                <div className="mt-3 space-y-2">
                  {suggestionPreview.visibleItems.map((item) => (
                    <div
                      key={item.id}
                      data-testid="grouped-suggestion-row"
                      className={`flex items-center gap-2.5 rounded-xl border px-3 py-2 text-sm ${styles.previewRowClassName}`}
                    >
                      <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${item.dotClassName}`} />
                      <span className="min-w-0 flex-1 truncate text-sm text-zinc-200">{item.title}</span>
                      <span className="shrink-0 text-[11px] text-zinc-500">{item.meta}</span>
                    </div>
                  ))}
                  {suggestionPreview.hiddenCount > 0 ? (
                    <div className={`rounded-xl border px-3 py-2 text-xs text-zinc-500 ${styles.previewRowClassName}`}>
                      +{suggestionPreview.hiddenCount} more
                    </div>
                  ) : null}
                </div>
              ) : null}
              {groupType !== 'suggestion' && summary ? (
                <p className={`mt-1.5 text-sm leading-relaxed text-zinc-300 ${groupType === 'suggestion' ? 'line-clamp-4' : 'line-clamp-2'}`}>{summary}</p>
              ) : null}
              {statusCounts ? <StatusIndicators counts={statusCounts} /> : null}

              {feedbackItems.length > 0 && (
                <div className="mt-3 space-y-1.5">
                  {feedbackItems.map((entry) => {
                    return (
                      <p
                        key={entry.id}
                        className={`line-clamp-2 text-xs leading-5 ${
                          entry.tone === 'error' ? 'text-red-300' : 'text-emerald-300'
                        }`}
                      >
                        <span className="font-medium text-zinc-200">{entry.label}:</span> {entry.message}
                      </p>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </button>

        {renderGroupActionBar(batchActions, chatAction)}
      </div>
    </article>
  );
}
