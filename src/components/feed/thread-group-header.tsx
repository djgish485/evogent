'use client';

import type { KeyboardEvent, SyntheticEvent } from 'react';
import { ThreadFeedbackControl, type ThreadFeedbackVote } from '@/components/feed/thread-feedback-control';
import type { ThreadTint } from '@/lib/thread-colors';
import type { FeedbackProbeMetadata, FeedProminence } from '@/types/feed';

interface ThreadGroupHeaderProps {
  threadId: string;
  cycleId: string;
  threadTitle: string;
  threadRationale: string | null;
  threadProminence: FeedProminence | null;
  feedbackProbe?: FeedbackProbeMetadata | null;
  sourceItemIds?: string[];
  continuing: boolean;
  threadTint: ThreadTint;
  isCollapsed: boolean;
  contentsId: string;
  onToggleCollapsed: () => void;
  onSubmitFeedback: (input: {
    threadId: string;
    cycleId: string;
    threadTitle: string;
    vote: ThreadFeedbackVote;
    reason: string;
    feedbackProbe?: FeedbackProbeMetadata | null;
    sourceItemIds?: string[];
  }) => Promise<void>;
}

export function ThreadGroupHeader({
  threadId,
  cycleId,
  threadTitle,
  threadRationale,
  threadProminence,
  feedbackProbe = null,
  sourceItemIds = [],
  continuing,
  threadTint,
  isCollapsed,
  contentsId,
  onToggleCollapsed,
  onSubmitFeedback,
}: ThreadGroupHeaderProps) {
  const titleClassName = threadProminence?.level === 'lead'
    ? 'text-[22px] font-semibold leading-tight text-zinc-50 sm:text-[28px]'
    : threadProminence?.level === 'prominent'
      ? 'text-lg font-semibold leading-tight text-zinc-50 sm:text-xl'
      : 'text-lg font-semibold text-zinc-100 sm:text-xl';
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;

    event.preventDefault();
    onToggleCollapsed();
  };
  const stopFeedbackPropagation = (event: SyntheticEvent) => {
    event.stopPropagation();
  };

  return (
    <header
      role="button"
      tabIndex={0}
      aria-expanded={!isCollapsed}
      aria-controls={contentsId}
      onClick={onToggleCollapsed}
      onKeyDown={handleKeyDown}
      className="cursor-pointer rounded-t-2xl border border-transparent p-4 outline-none transition focus-visible:ring-2 focus-visible:ring-zinc-400/60 sm:p-5"
      style={{
        background: `linear-gradient(to bottom, ${threadTint.bg}, transparent) padding-box, linear-gradient(to bottom, ${threadTint.border}, transparent) border-box`,
      }}
    >
      <div className="flex flex-row items-start justify-between gap-3 sm:gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className="rounded-full border bg-zinc-950/50 px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.18em]"
            style={{ borderColor: threadTint.border, color: threadTint.text }}
          >
            Thread
          </span>
          {continuing ? (
            <span className="text-xs text-zinc-400">Continuing from earlier</span>
          ) : null}
        </div>
        <div onClick={stopFeedbackPropagation} onKeyDown={stopFeedbackPropagation}>
          <ThreadFeedbackControl
            threadId={threadId}
            cycleId={cycleId}
            threadTitle={threadTitle}
            feedbackProbe={feedbackProbe}
            sourceItemIds={sourceItemIds}
            onSubmit={onSubmitFeedback}
          />
        </div>
      </div>
      <div className="mt-2 space-y-1">
        <h2 className={titleClassName} data-prominence={threadProminence?.level}>{threadTitle}</h2>
        {threadRationale ? (
          <p className="text-sm leading-6 text-zinc-300">{threadRationale}</p>
        ) : null}
      </div>
    </header>
  );
}
