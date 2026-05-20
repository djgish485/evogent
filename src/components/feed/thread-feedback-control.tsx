'use client';

import { useState } from 'react';
import type { FeedbackProbeMetadata } from '@/types/feed';

export type ThreadFeedbackVote = 'up' | 'down';

interface ThreadFeedbackControlProps {
  threadId: string;
  threadTitle: string;
  feedbackProbe?: FeedbackProbeMetadata | null;
  sourceItemIds?: string[];
  thumbsDownDisabled?: boolean;
  onThumbsDown: () => void;
  onSubmit: (input: {
    threadId: string;
    threadTitle: string;
    vote: ThreadFeedbackVote;
    reason: string;
    feedbackProbe?: FeedbackProbeMetadata | null;
    sourceItemIds?: string[];
  }) => Promise<void>;
}

function ThumbIcon({ direction }: { direction: ThreadFeedbackVote }) {
  const path = direction === 'up'
    ? 'M8.46 2.53a1 1 0 0 1 1.84.77l-.65 2.6h4.1a2.25 2.25 0 0 1 2.19 2.77l-1.1 4.8a2.25 2.25 0 0 1-2.2 1.75H7.75A1.75 1.75 0 0 1 6 14.47V8.9c0-.7.24-1.37.67-1.9l1.79-2.2Zm-4.96 4.7A1.5 1.5 0 0 1 5 8.73v5.77A1.5 1.5 0 0 1 3.5 16h-.75A1.75 1.75 0 0 1 1 14.25V8.98a1.75 1.75 0 0 1 1.75-1.75h.75Z'
    : 'M11.54 17.47a1 1 0 0 1-1.84-.77l.65-2.6h-4.1a2.25 2.25 0 0 1-2.19-2.77l1.1-4.8a2.25 2.25 0 0 1 2.2-1.75h4.89A1.75 1.75 0 0 1 14 5.53v5.57c0 .7-.24 1.37-.67 1.9l-1.79 2.2Zm4.96-4.7A1.5 1.5 0 0 1 15 11.27V5.5A1.5 1.5 0 0 1 16.5 4h.75A1.75 1.75 0 0 1 19 5.75v5.27a1.75 1.75 0 0 1-1.75 1.75h-.75Z';
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" className="h-4 w-4 fill-current">
      <path d={path} />
    </svg>
  );
}

export function ThreadFeedbackControl({
  threadId,
  threadTitle,
  feedbackProbe = null,
  sourceItemIds = [],
  thumbsDownDisabled = false,
  onThumbsDown,
  onSubmit,
}: ThreadFeedbackControlProps) {
  const [reason, setReason] = useState('');
  const [showReasonForm, setShowReasonForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [statusTone, setStatusTone] = useState<'success' | 'error'>('success');

  const handleCancel = () => { setShowReasonForm(false); setReason(''); };

  const handleSubmit = async () => {
    if (!showReasonForm || saving) return;

    setSaving(true);
    setStatusMessage(null);

    try {
      await onSubmit({
        threadId,
        threadTitle,
        vote: 'up',
        reason: reason.trim(),
        feedbackProbe,
        sourceItemIds,
      });
      setReason('');
      setShowReasonForm(false);
      setStatusTone('success');
      setStatusMessage(feedbackProbe ? 'Feedback saved.' : 'Feedback saved to chat.');
    } catch (error) {
      setShowReasonForm(false);
      setStatusTone('error');
      setStatusMessage(error instanceof Error ? error.message : 'Failed to save feedback.');
    } finally {
      setSaving(false);
    }
  };

  const moreLabel = feedbackProbe?.options?.moreLabel ?? feedbackProbe?.options?.positiveLabel ?? 'More like this';
  const lessLabel = feedbackProbe?.options?.lessLabel ?? feedbackProbe?.options?.negativeLabel ?? 'Less like this';
  const reasonForm = showReasonForm ? (
    <div className={feedbackProbe ? 'mt-2 rounded-md border border-amber-400/20 bg-black/20 p-2' : 'w-56 rounded-lg border border-zinc-800 bg-black/30 p-2 sm:w-64'}>
      <form onSubmit={(event) => { event.preventDefault(); void handleSubmit(); }}>
        <input type="text" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Optional reason" className={`w-full rounded-md border bg-black/30 px-3 py-2 text-xs text-zinc-100 outline-none transition ${feedbackProbe ? 'border-zinc-700 focus:border-amber-300/60' : 'border-zinc-800 focus:border-emerald-500/60'}`} />
        <div className="mt-2 flex justify-end gap-2">
          <button type="submit" disabled={saving} className="inline-flex min-h-11 items-center justify-center rounded-md border border-emerald-400/35 bg-emerald-500/15 px-4 text-sm font-semibold text-emerald-100 transition hover:bg-emerald-500/25 disabled:cursor-not-allowed disabled:opacity-60">{saving ? 'Saving...' : 'Save'}</button>
          <button type="button" onClick={handleCancel} disabled={saving} className="inline-flex min-h-11 items-center justify-center rounded-md border border-zinc-700 bg-zinc-900/80 px-4 text-sm font-semibold text-zinc-300 transition hover:border-zinc-600 hover:bg-zinc-800/90 disabled:cursor-not-allowed disabled:opacity-60">Cancel</button>
        </div>
      </form>
    </div>
  ) : null;
  const status = statusMessage ? <p className={`${feedbackProbe ? 'mt-2 ' : ''}text-[11px] ${statusTone === 'error' ? 'text-red-300' : 'text-emerald-300'}`}>{statusMessage}</p> : null;

  if (feedbackProbe) {
    return (
      <div className="flex w-48 flex-col gap-2 sm:w-[360px]">
        <div className="rounded-lg border border-amber-400/25 bg-amber-400/10 p-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-200">Tune this lane</span>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <button type="button" onClick={() => { setShowReasonForm(true); setStatusMessage(null); }} disabled={saving} className="inline-flex min-h-12 items-center justify-center rounded-md border border-emerald-400/45 bg-emerald-500/15 px-4 py-3 text-sm font-semibold text-emerald-100 transition hover:bg-emerald-500/25 disabled:cursor-not-allowed disabled:opacity-60">{moreLabel}</button>
            <button type="button" onClick={onThumbsDown} disabled={saving || thumbsDownDisabled} className="inline-flex min-h-12 items-center justify-center rounded-md border border-rose-400/35 bg-rose-500/10 px-4 py-3 text-sm font-semibold text-rose-100 transition hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-60">{lessLabel}</button>
          </div>
          {reasonForm}
          {status}
        </div>
      </div>
    );
  }

  return (
    <div className="flex shrink-0 flex-col items-end gap-2">
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => { setShowReasonForm(true); setStatusMessage(null); }} disabled={saving} aria-label="Thumbs up thread" className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-emerald-500/35 bg-emerald-500/10 text-emerald-200 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-60">
          <ThumbIcon direction="up" />
        </button>
        <button type="button" onClick={onThumbsDown} disabled={saving || thumbsDownDisabled} aria-label="Thumbs down thread" className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-zinc-700 bg-zinc-900/80 text-zinc-300 transition hover:border-zinc-600 hover:bg-zinc-800/90 disabled:cursor-not-allowed disabled:opacity-60">
          <ThumbIcon direction="down" />
        </button>
      </div>
      {reasonForm}
      {status}
    </div>
  );
}
