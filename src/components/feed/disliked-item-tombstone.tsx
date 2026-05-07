'use client';

import { useId, type SyntheticEvent } from 'react';

interface DislikedItemTombstoneProps {
  label: string;
  pendingReason: string;
  savingReason: boolean;
  error: string | null;
  reasonSaved?: boolean;
  onPendingReasonChange: (reason: string) => void;
  onUndo: () => void | Promise<void>;
  onSubmitReason: (reason: string) => void | Promise<void>;
}

export function DislikedItemTombstone({
  label,
  pendingReason,
  savingReason,
  error,
  reasonSaved = false,
  onPendingReasonChange,
  onUndo,
  onSubmitReason,
}: DislikedItemTombstoneProps) {
  const inputId = useId();
  const stopPropagation = (event: SyntheticEvent) => {
    event.stopPropagation();
  };

  return (
    <div
      role="status"
      aria-label={`${label} removed from the feed`}
      className="w-full rounded-xl border border-zinc-800/80 bg-zinc-950/70 px-3 py-2 text-sm text-zinc-400"
      onClick={stopPropagation}
      onKeyDown={stopPropagation}
      onTouchStart={stopPropagation}
    >
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
        <button
          type="button"
          onClick={() => { void onUndo(); }}
          disabled={savingReason}
          className="self-start rounded-full border border-zinc-700 px-3 py-1 text-xs font-medium text-zinc-200 underline-offset-4 transition hover:border-zinc-500 hover:text-zinc-50 hover:underline disabled:cursor-not-allowed disabled:opacity-60"
        >
          Undo
        </button>

        {reasonSaved ? null : (
          <form
            className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center"
            onSubmit={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void onSubmitReason(pendingReason);
            }}
          >
            <label htmlFor={inputId} className="sr-only">Optional reason for removing {label}</label>
            <input
              id={inputId}
              type="text"
              value={pendingReason}
              onChange={(event) => onPendingReasonChange(event.target.value)}
              placeholder="Optional reason"
              enterKeyHint="done"
              className="min-h-9 min-w-0 flex-1 rounded-md border border-zinc-800 bg-black/30 px-3 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-zinc-500"
              disabled={savingReason}
            />
            {pendingReason.trim().length > 0 ? <button
              type="submit"
              disabled={savingReason}
              className="inline-flex min-h-9 items-center justify-center rounded-md border border-zinc-700 bg-zinc-900/80 px-3 text-sm font-medium text-zinc-200 transition hover:border-zinc-600 hover:bg-zinc-800/90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {savingReason ? 'Saving...' : 'Save'}
            </button> : null}
          </form>
        )}
      </div>

      {error ? <p className="mt-2 text-xs text-red-300">{error}</p> : null}
    </div>
  );
}
