'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FeedMarkdown, FEED_MARKDOWN_COMPACT_BODY_CLASS_NAME } from '@/components/feed/feed-markdown';
import {
  canHideSuggestion,
  getFeedSuggestionAcceptLabel,
  getFeedSuggestionDefaultTitle,
  getFeedSuggestionLabel,
  getSuggestionStatusFeedback,
  getSuggestionStatusLabel,
  isSuggestionActionable,
  isCodeFixSuggestion,
} from '@/lib/feed-suggestions';
import { formatCompactTimestamp } from '@/lib/compact-timestamp';
import { useOverlayDismiss } from '@/lib/overlay-dismiss';
import {
  resolveSuggestionCreatorLabel,
  type SuggestionCreatorSessionTitles,
} from '@/lib/suggestion-creator-label';
import { buildSearchSnippet, splitSearchHighlightParts } from '@/lib/search-utils';
import type { FeedItem, SuggestionStatus } from '@/types/feed';

export interface CodeFixProgress {
  phase: string;
  detail: string | null;
}

interface SuggestionCardProps {
  item: FeedItem;
  status: SuggestionStatus;
  renderDismissed?: boolean;
  pendingAction: 'accept' | 'dismiss' | null;
  feedback?: string | null;
  codeFixProgress?: CodeFixProgress | null;
  onAccept: (item: FeedItem) => void;
  onDismiss: (item: FeedItem) => void;
  onChatAboutSuggestion?: (item: FeedItem) => void;
  onRetry?: (item: FeedItem) => void;
  onCancel?: (item: FeedItem) => void;
  creatorSessionTitles?: SuggestionCreatorSessionTitles;
  searchQuery?: string | null;
}

const PHASE_LABELS: Record<string, string> = {
  spawning: 'Spawning agent...',
  running: 'Agent working...',
  building: 'Building & testing...',
  merging: 'Merging changes...',
  finishing: 'Finishing up...',
  done: 'Complete',
  failed: 'Failed',
};

const PHASE_ORDER = ['spawning', 'running', 'building', 'merging', 'done'];
const BASE_CARD_CLASS_NAME = 'group relative w-full overflow-hidden rounded-[1.25rem] border border-zinc-800/70 bg-black/24 px-4 py-4 shadow-[0_10px_28px_rgba(0,0,0,0.12)] transition-[background-color,border-color,box-shadow] hover:border-zinc-700/75 hover:bg-zinc-950/62 hover:shadow-[0_16px_34px_rgba(0,0,0,0.18)]';
const FAILED_CARD_CLASS_NAME = 'group relative w-full overflow-hidden rounded-[1.25rem] border border-rose-900/55 bg-rose-950/12 px-4 py-4 shadow-[0_10px_28px_rgba(0,0,0,0.14)] transition-[background-color,border-color,box-shadow] hover:border-rose-700/70 hover:bg-rose-950/20 hover:shadow-[0_16px_34px_rgba(0,0,0,0.2)]';

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

function useAgentLogs(taskId: string | null, active: boolean) {
  const [lines, setLines] = useState<string[]>([]);
  const scrollRef = useRef<HTMLPreElement>(null);
  const prevKeyRef = useRef<string | null>(null);

  // Reset lines when taskId/active changes to inactive
  const key = taskId && active ? taskId : null;
  if (key !== prevKeyRef.current) {
    prevKeyRef.current = key;
    if (!key && lines.length > 0) {
      setLines([]);
    }
  }

  useEffect(() => {
    if (!key) return;

    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(`/api/internal/code-fix-orchestrator/logs/${encodeURIComponent(key)}?lines=30`);
        if (!res.ok || cancelled) return;
        const data = await res.json() as { ok: boolean; lines?: string[] };
        if (data.ok && Array.isArray(data.lines) && !cancelled) {
          setLines(data.lines);
        }
      } catch {
        // ignore fetch errors
      }
    };

    void poll();
    const interval = setInterval(poll, 5000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [key]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines]);

  return { lines, scrollRef };
}

function AgentLogPanel({ taskId, active }: { taskId: string | null; active: boolean }) {
  const { lines, scrollRef } = useAgentLogs(taskId, active);
  const [expanded, setExpanded] = useState(false);

  if (!taskId || !active) return null;

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="text-[11px] font-medium text-amber-300/70 hover:text-amber-200 transition-colors"
      >
        {expanded ? 'Hide logs' : 'Show agent logs'}
      </button>
      {expanded && (
        <pre
          ref={scrollRef}
          className="mt-1 max-h-40 overflow-auto rounded border border-amber-700/30 bg-black/60 p-2 text-[10px] leading-4 text-zinc-400 font-mono"
        >
          {lines.length > 0 ? lines.join('\n') : 'Waiting for log output...'}
        </pre>
      )}
    </div>
  );
}

function getPhaseIndex(phase: string): number {
  const idx = PHASE_ORDER.indexOf(phase);
  return idx >= 0 ? idx : 1;
}

type ActionIcon = 'cancel' | 'chat' | 'details' | 'dismiss' | 'retry';
type ActionTone = 'default' | 'danger' | 'primary' | 'warning';

function renderActionIcon(icon: ActionIcon) {
  switch (icon) {
    case 'cancel':
      return (
        <svg aria-hidden="true" viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.85">
          <path d="M6.25 6.25 13.75 13.75M13.75 6.25 6.25 13.75" strokeLinecap="round" />
        </svg>
      );
    case 'chat':
      return (
        <svg aria-hidden="true" viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M4.25 5.75A2.75 2.75 0 0 1 7 3h6a2.75 2.75 0 0 1 2.75 2.75v3.5A2.75 2.75 0 0 1 13 12H9.91l-3.42 3.08c-.48.43-1.24.09-1.24-.56V12A2.75 2.75 0 0 1 2.5 9.25v-3.5A2.75 2.75 0 0 1 5.25 3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'details':
      return (
        <svg aria-hidden="true" viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.85">
          <circle cx="10" cy="10" r="6.5" />
          <path d="M10 8.25v5" strokeLinecap="round" />
          <circle cx="10" cy="5.75" r="0.9" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'dismiss':
      return (
        <svg aria-hidden="true" viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M6.25 6.25 13.75 13.75M13.75 6.25 6.25 13.75" strokeLinecap="round" />
        </svg>
      );
    case 'retry':
      return (
        <svg aria-hidden="true" viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M15.25 7.25A5.75 5.75 0 1 0 16 10" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M15.25 3.75v3.5h-3.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
  }
}

function getActionButtonClassName(tone: ActionTone = 'default') {
  const base = 'inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-60';

  switch (tone) {
    case 'danger':
      return `${base} border-red-800/60 bg-red-950/18 text-red-200 hover:border-red-600/80 hover:bg-red-950/35 hover:text-red-100`;
    case 'primary':
      return `${base} border-emerald-700/70 bg-emerald-950/28 text-emerald-100 hover:border-emerald-500/80 hover:bg-emerald-900/42`;
    case 'warning':
      return `${base} border-amber-700/65 bg-amber-950/25 text-amber-100 hover:border-amber-500/80 hover:bg-amber-900/38`;
    default:
      return `${base} border-zinc-700/70 bg-zinc-950/40 text-zinc-300 hover:border-zinc-500/85 hover:bg-zinc-900/75 hover:text-zinc-100`;
  }
}

function IconActionButton({
  icon,
  label,
  testId,
  disabled,
  onClick,
  tone = 'default',
}: {
  icon: ActionIcon;
  label: string;
  testId?: string;
  disabled?: boolean;
  onClick: () => void;
  tone?: ActionTone;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={getActionButtonClassName(tone)}
    >
      {renderActionIcon(icon)}
    </button>
  );
}

function getRailClassName(status: SuggestionStatus, isCodeFix: boolean) {
  if (status === 'failed') return 'bg-rose-400/70';
  if (status === 'merged' || status === 'accepted') return 'bg-emerald-400/70';
  if (status === 'dispatched' || status === 'running') return 'bg-amber-400/75';
  if (isCodeFix) return 'bg-amber-300/45';
  return 'bg-cyan-300/45';
}

function SuggestionDetailModal({
  item,
  status,
  creatorLabel,
  onClose,
}: {
  item: FeedItem;
  status: SuggestionStatus;
  creatorLabel: string | null;
  onClose: () => void;
}) {
  const { backdropProps } = useOverlayDismiss({
    enabled: true,
    onClose,
    closeOnBackdropPress: true,
  });

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  const proposedValue = typeof item.metadata?.proposedValue === 'string'
    ? item.metadata.proposedValue.trim()
    : '';
  const configFile = typeof item.metadata?.configFile === 'string'
    ? item.metadata.configFile.trim()
    : '';
  const taskId = typeof item.metadata?.taskId === 'string'
    ? item.metadata.taskId.trim()
    : '';
  const createdAt = item.createdAt || item.publishedAt;

  if (typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <div className="pointer-events-auto fixed inset-0 z-[100] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby={`suggestion-detail-title-${item.id}`}>
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-black/75"
        {...backdropProps}
      />
      <div className="relative z-[101] max-h-[85vh] w-full max-w-2xl overflow-hidden rounded-[1.75rem] border border-zinc-800 bg-zinc-950 shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-white/8 px-5 py-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-zinc-700/80 bg-zinc-900/70 px-2 py-0.5 text-[11px] font-medium text-zinc-200">
                {getFeedSuggestionLabel(item)}
              </span>
              <span className="rounded-full border border-zinc-700/80 bg-zinc-900/70 px-2 py-0.5 text-[11px] font-medium text-zinc-200">
                {getSuggestionStatusLabel(status)}
              </span>
            </div>
            <h2 id={`suggestion-detail-title-${item.id}`} className="mt-2 text-lg font-semibold text-zinc-50">
              {item.title || getFeedSuggestionDefaultTitle(item)}
            </h2>
            {creatorLabel ? (
              <p className="mt-1 truncate text-xs text-zinc-500" data-testid="suggestion-creator-subtitle">
                {creatorLabel}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-zinc-700 bg-zinc-900/70 text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100"
            aria-label="Close suggestion details"
          >
            <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4" fill="currentColor">
              <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22z" />
            </svg>
          </button>
        </div>

        <div className="max-h-[calc(85vh-5.5rem)] space-y-4 overflow-y-auto px-5 py-4">
          {item.text.trim() ? (
            <section>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-zinc-400">Summary</p>
              <div className="mt-2">
                <FeedMarkdown
                  text={item.text}
                  className={FEED_MARKDOWN_COMPACT_BODY_CLASS_NAME}
                />
              </div>
            </section>
          ) : null}

          {item.reason?.trim() ? (
            <section>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-zinc-400">Reason</p>
              <div className="mt-2">
                <FeedMarkdown
                  text={item.reason.trim()}
                  className={FEED_MARKDOWN_COMPACT_BODY_CLASS_NAME}
                />
              </div>
            </section>
          ) : null}

          {proposedValue ? (
            <section>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-zinc-400">Underlying Detail</p>
              <div className="mt-2 rounded-2xl border border-zinc-800 bg-black/35 p-3">
                <FeedMarkdown
                  text={proposedValue}
                  className={FEED_MARKDOWN_COMPACT_BODY_CLASS_NAME}
                />
              </div>
            </section>
          ) : null}

          <section>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-zinc-400">Metadata</p>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {createdAt ? (
                <div className="rounded-2xl border border-zinc-800 bg-black/25 px-3 py-2">
                  <p className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">Created</p>
                  <p className="mt-1 text-sm text-zinc-100">{formatCompactTimestamp(createdAt)}</p>
                </div>
              ) : null}
              {configFile ? (
                <div className="rounded-2xl border border-zinc-800 bg-black/25 px-3 py-2">
                  <p className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">Target File</p>
                  <p className="mt-1 break-all text-sm text-zinc-100">{configFile}</p>
                </div>
              ) : null}
              {taskId ? (
                <div className="rounded-2xl border border-zinc-800 bg-black/25 px-3 py-2 sm:col-span-2">
                  <p className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">Task</p>
                  <p className="mt-1 break-all text-sm text-zinc-100">{taskId}</p>
                </div>
              ) : null}
            </div>
          </section>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function SuggestionCard({
  item,
  status,
  renderDismissed = false,
  pendingAction,
  feedback,
  codeFixProgress,
  onAccept,
  onDismiss,
  onChatAboutSuggestion,
  onRetry,
  onCancel,
  creatorSessionTitles,
  searchQuery = null,
}: SuggestionCardProps) {
  const [isDetailsOpen, setIsDetailsOpen] = useState(false);

  if (status === 'dismissed' && !renderDismissed) {
    return null;
  }

  const isCodeFix = isCodeFixSuggestion(item);
  const title = item.title || getFeedSuggestionDefaultTitle(item);
  const creatorLabel = resolveSuggestionCreatorLabel(item, creatorSessionTitles);
  const disabled = pendingAction !== null;
  const statusFeedback = feedback ?? getSuggestionStatusFeedback(item, status);
  const feedbackClassName = `text-xs ${(statusFeedback || '').toLowerCase().includes('failed') ? 'text-red-300' : 'text-emerald-300'}`;
  const canAccept = isSuggestionActionable(status);
  const hideable = canHideSuggestion(status);
  const tintClassName = status === 'failed'
    ? 'bg-rose-950/10'
    : status === 'dispatched' || status === 'running'
      ? 'bg-amber-950/[0.08]'
      : isCodeFix
        ? 'bg-amber-950/[0.05]'
        : 'bg-cyan-950/[0.05]';
  const badgeClassName = isCodeFix
    ? 'rounded-full border border-amber-700/55 bg-amber-950/28 px-2 py-0.5 text-[11px] font-medium text-amber-100'
    : 'rounded-full border border-cyan-700/55 bg-cyan-950/28 px-2 py-0.5 text-[11px] font-medium text-cyan-100';
  const statusBadgeClassName = status === 'failed'
    ? 'rounded-full border border-red-700/60 bg-red-950/30 px-2 py-0.5 text-[11px] font-medium text-red-100'
    : status === 'merged' || status === 'accepted'
      ? 'rounded-full border border-emerald-700/60 bg-emerald-950/28 px-2 py-0.5 text-[11px] font-medium text-emerald-100'
      : 'rounded-full border border-amber-700/60 bg-amber-950/28 px-2 py-0.5 text-[11px] font-medium text-amber-100';

  const isInProgress = isCodeFix && (status === 'dispatched' || status === 'running');
  const showProgress = isInProgress && codeFixProgress;
  const phase = codeFixProgress?.phase || 'spawning';
  const phaseLabel = PHASE_LABELS[phase] || 'Working...';
  const phaseIdx = getPhaseIndex(phase);
  const taskId = typeof item.metadata?.taskId === 'string' ? item.metadata.taskId : null;
  const attemptNumber = typeof item.metadata?.codeFixAttemptNumber === 'number' && Number.isInteger(item.metadata.codeFixAttemptNumber)
    ? item.metadata.codeFixAttemptNumber
    : 1;
  const retryOfTaskId = typeof item.metadata?.codeFixRetryOfTaskId === 'string' && item.metadata.codeFixRetryOfTaskId.trim()
    ? item.metadata.codeFixRetryOfTaskId.trim()
    : typeof item.metadata?.codeFixPreviousTaskId === 'string' && item.metadata.codeFixPreviousTaskId.trim()
      ? item.metadata.codeFixPreviousTaskId.trim()
      : null;
  const suggestedAt = item.createdAt || item.publishedAt;
  const suggestedAtLabel = formatCompactTimestamp(suggestedAt);
  // Show log panel for any in-progress code fix that has a taskId, even without progress data
  const showLogPanel = isInProgress && !!taskId;
  const cardClassName = status === 'failed' ? FAILED_CARD_CLASS_NAME : BASE_CARD_CLASS_NAME;
  const railClassName = getRailClassName(status, isCodeFix);
  const searchSnippet = searchQuery ? buildSearchSnippet(item.text, searchQuery, 220) : null;

  return (
    <>
      <article
        data-testid="suggestion-card"
        data-item-type="suggestion"
        data-item-id={item.id}
        data-feed-item-id={item.id}
        data-feed-item-type={item.type}
        className={cardClassName}
      >
        <div className={`pointer-events-none absolute inset-0 ${tintClassName}`} />
        <span className={`pointer-events-none absolute bottom-4 left-0 top-4 w-[3px] rounded-r-full ${railClassName}`} aria-hidden="true" />
        <div className="relative pl-2 sm:pl-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className={badgeClassName}>
                {getFeedSuggestionLabel(item)}
              </span>
              <span className={statusBadgeClassName}>
                {getSuggestionStatusLabel(status)}
              </span>
              {suggestedAtLabel ? (
                <time
                  dateTime={suggestedAt}
                  className="text-[11px] text-zinc-500"
                >
                  {suggestedAtLabel}
                </time>
              ) : null}
            </div>

            <div className="flex shrink-0 items-center gap-1">
              <IconActionButton
                icon="details"
                label={`View details for ${title}`}
                testId="suggestion-details-button"
                onClick={() => setIsDetailsOpen(true)}
              />
              {onChatAboutSuggestion ? (
                <IconActionButton
                  icon="chat"
                  label="Chat about this suggestion"
                  testId="suggestion-chat-button"
                  disabled={disabled}
                  onClick={() => onChatAboutSuggestion(item)}
                />
              ) : null}
              {!hideable && status !== 'dismissed' ? (
                <IconActionButton
                  icon="dismiss"
                  label={pendingAction === 'dismiss' ? 'Dismissing suggestion' : 'Dismiss suggestion'}
                  testId="suggestion-dismiss-button"
                  disabled={disabled}
                  onClick={() => onDismiss(item)}
                />
              ) : null}
            </div>
          </div>

          <div className="mt-2">
            <h3 className="text-[15px] font-semibold leading-5 text-zinc-100 sm:text-base sm:leading-6">
              <HighlightedSearchText text={title} searchQuery={searchQuery} />
            </h3>
            {creatorLabel ? (
              <p className="mt-1 truncate text-xs leading-5 text-zinc-500" data-testid="suggestion-creator-subtitle">
                {creatorLabel}
              </p>
            ) : null}
            {isCodeFix && attemptNumber > 1 ? (
              <p className="mt-1 text-[11px] text-amber-300/75">
                Attempt {attemptNumber}{retryOfTaskId ? ` after ${retryOfTaskId}` : ''}.
              </p>
            ) : null}
            {searchSnippet?.hasMatch ? (
              <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-sm leading-6 text-zinc-300">
                <HighlightedSearchText text={searchSnippet.text} searchQuery={searchQuery} />
              </p>
            ) : null}
          </div>

          {isInProgress && (
            <div className="mt-4 rounded-2xl border border-amber-800/40 bg-amber-950/16 px-3 py-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-amber-400" />
                  <span className="truncate text-xs font-medium text-amber-100">{showProgress ? phaseLabel : 'Agent dispatched...'}</span>
                </div>
                {onCancel && (
                  <button
                    type="button"
                    data-testid="suggestion-cancel-button"
                    disabled={disabled}
                    onClick={() => onCancel(item)}
                    className="min-h-8 rounded-full border border-red-800/60 bg-red-950/20 px-3 py-1 text-xs font-medium text-red-200 transition-colors hover:border-red-600/80 hover:bg-red-950/35 disabled:cursor-not-allowed disabled:opacity-65"
                  >
                    Cancel
                  </button>
                )}
              </div>
              {codeFixProgress?.detail && (
                <p className="mt-1 truncate text-[11px] text-amber-300/70">{codeFixProgress.detail}</p>
              )}
              {showProgress && (
                <>
                  <div className="mt-2 flex gap-1">
                    {PHASE_ORDER.map((step, i) => (
                      <div
                        key={step}
                        className={`h-1 flex-1 rounded-full ${
                          i <= phaseIdx ? 'bg-amber-400' : 'bg-amber-900/50'
                        }`}
                      />
                    ))}
                  </div>
                  <div className="mt-1 flex justify-between text-[10px] text-amber-400/50">
                    <span>Spawn</span>
                    <span>Run</span>
                    <span>Build</span>
                    <span>Merge</span>
                    <span>Done</span>
                  </div>
                </>
              )}
            </div>
          )}

          {showLogPanel && <AgentLogPanel taskId={taskId} active={showLogPanel} />}

          {hideable && statusFeedback ? (
            <p className={`mt-3 ${feedbackClassName}`}>{statusFeedback}</p>
          ) : null}

          {status === 'failed' && isCodeFix && onRetry ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                data-testid="suggestion-retry-button"
                disabled={disabled}
                onClick={() => onRetry(item)}
                className="inline-flex min-h-9 items-center gap-2 rounded-full border border-amber-700/70 bg-amber-950/28 px-3 py-1.5 text-xs font-medium text-amber-100 transition-colors hover:border-amber-500/80 hover:bg-amber-900/40 disabled:cursor-not-allowed disabled:opacity-65"
              >
                {renderActionIcon('retry')}
                <span>{pendingAction === 'accept' ? 'Retrying...' : 'Retry'}</span>
              </button>
            </div>
          ) : null}

          {!hideable && status !== 'dismissed' ? (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button
                type="button"
                data-testid="suggestion-accept-button"
                disabled={disabled || !canAccept}
                onClick={() => onAccept(item)}
                className="min-h-10 rounded-full border border-emerald-700/70 bg-emerald-950/32 px-4 py-2 text-sm font-medium text-emerald-100 transition-colors hover:border-emerald-500/80 hover:bg-emerald-900/45 disabled:cursor-not-allowed disabled:opacity-65"
              >
                {getFeedSuggestionAcceptLabel(item, pendingAction === 'accept')}
              </button>
            </div>
          ) : null}

          {status === 'dismissed' ? (
            <p className="mt-3 text-xs text-zinc-500">Dismissed suggestions stay in history.</p>
          ) : null}

          {!hideable && feedback && (
            <p className={`mt-2 text-xs ${feedback.toLowerCase().includes('failed') ? 'text-red-300' : 'text-emerald-300'}`}>
              {feedback}
            </p>
          )}
        </div>
      </article>

      {isDetailsOpen ? (
        <SuggestionDetailModal
          item={item}
          status={status}
          creatorLabel={creatorLabel}
          onClose={() => setIsDetailsOpen(false)}
        />
      ) : null}
    </>
  );
}
