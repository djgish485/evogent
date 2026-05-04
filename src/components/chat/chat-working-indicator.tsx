import { renderChatMarkdown } from '@/lib/chat-markdown';
import { type LiveActivityStatus } from '@/lib/chat-streaming-display';

export function ChatStopButton({
  onClick,
  variant = 'stop',
  title,
  ariaLabel,
  disabled = false,
}: {
  onClick: () => void;
  variant?: 'stop' | 'dismiss';
  title?: string;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  const isDismiss = variant === 'dismiss';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border transition focus:outline-none focus:ring-2 ${
        isDismiss
          ? 'border-zinc-700/90 bg-zinc-950/40 text-zinc-300 hover:bg-zinc-900/80 focus:ring-zinc-500/50'
          : 'border-rose-800/80 bg-rose-950/25 text-rose-200 hover:bg-rose-950/45 focus:ring-rose-500/60'
      } disabled:cursor-not-allowed disabled:opacity-50`}
      aria-label={ariaLabel ?? (isDismiss ? 'Cancel queued message' : 'Stop agent')}
      title={title ?? (isDismiss ? 'Cancel queued message' : 'Stop')}
    >
      <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3 w-3 fill-current">
        {isDismiss ? (
          <path d="M4.22 4.22a.75.75 0 0 1 1.06 0L8 6.94l2.72-2.72a.75.75 0 1 1 1.06 1.06L9.06 8l2.72 2.72a.75.75 0 1 1-1.06 1.06L8 9.06l-2.72 2.72a.75.75 0 1 1-1.06-1.06L6.94 8 4.22 5.28a.75.75 0 0 1 0-1.06Z" />
        ) : (
          <rect x="4" y="4" width="8" height="8" rx="1.5" />
        )}
      </svg>
    </button>
  );
}

export function ChatWorkingIndicator({
  label,
  detail,
  badge,
  status = 'running',
  onStop,
  onCancelQueued,
  muted = false,
}: {
  label: string;
  detail?: string | null;
  badge?: string | null;
  status?: LiveActivityStatus;
  onStop?: (() => void) | null;
  onCancelQueued?: (() => void) | null;
  muted?: boolean;
}) {
  const isQueued = status === 'queued';
  const isStalled = status === 'stalled';
  const indicatorColorClass = isQueued
    ? 'text-sky-300'
    : isStalled
      ? 'text-amber-300'
      : 'text-emerald-300';
  const badgeClass = isQueued
    ? 'border-sky-500/30 bg-sky-500/10 text-sky-100/90'
    : isStalled
      ? 'border-amber-500/30 bg-amber-500/10 text-amber-100/90'
      : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-100/90';

  return (
    <div
      data-testid="chat-working-indicator"
      data-chat-live-state={status}
      className={`mt-2 rounded-2xl border border-zinc-800 bg-zinc-900/80 px-3 py-2.5 ${muted ? 'opacity-70' : ''}`}
      aria-live={muted ? 'off' : 'polite'}
    >
      <div className="flex min-h-12 items-start gap-3">
        <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center ${indicatorColorClass}`} aria-hidden="true">
          {muted ? (
            <span className="h-2.5 w-2.5 rounded-full bg-current opacity-80" />
          ) : isQueued ? (
            <span className="relative flex h-2.5 w-2.5">
              <span
                className="absolute inset-0 animate-ping rounded-full"
                style={{ backgroundColor: 'currentColor', opacity: 0.35 }}
              />
              <span className="relative h-2.5 w-2.5 rounded-full bg-current" />
            </span>
          ) : (
            <svg viewBox="0 0 24 24" className="h-4 w-4 animate-spin">
              <circle cx="12" cy="12" r="9" className="fill-none stroke-current opacity-25" strokeWidth="2.5" />
              <path d="M12 3a9 9 0 0 1 9 9" className="fill-none stroke-current" strokeLinecap="round" strokeWidth="2.5" />
            </svg>
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-zinc-400">
            {badge ? (
              <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] ${badgeClass}`}>
                {badge}
              </span>
            ) : null}
            <span className={muted ? 'text-zinc-300' : 'text-zinc-200'}>{label}</span>
          </div>
          {detail ? (
            <div className={`mt-1 text-sm leading-5 ${muted ? 'text-zinc-300' : 'text-zinc-100'}`}>
              {renderChatMarkdown(detail)}
            </div>
          ) : null}
        </div>
        {!muted && (onCancelQueued || onStop) ? (
          <div className="flex shrink-0 items-center gap-2">
            {onCancelQueued ? (
              <ChatStopButton
                onClick={onCancelQueued}
                variant="dismiss"
                title="Cancel queued message"
                ariaLabel="Cancel queued message"
              />
            ) : null}
            {onStop ? (
              <ChatStopButton
                onClick={onStop}
                variant={status === 'queued' ? 'dismiss' : 'stop'}
                title={status === 'queued' ? 'Cancel queued message' : 'Stop'}
                ariaLabel={status === 'queued' ? 'Cancel queued message' : 'Stop agent'}
              />
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
