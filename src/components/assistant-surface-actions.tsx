interface AssistantSurfaceActionsProps {
  bridgeReady: boolean;
  onClose: () => void;
  onOpenEvogent: () => void;
}

/**
 * Persistent controls for the explicitly invoked Android assistant surface.
 *
 * The retired cross-app bubble used to be the composer's close toggle. These controls live
 * inside Evogent's ordinary assistant Activity instead, so the surface remains visibly and
 * accessibly escapable without restoring any draw-over-other-apps capability.
 */
export function AssistantSurfaceActions({
  bridgeReady,
  onClose,
  onOpenEvogent,
}: AssistantSurfaceActionsProps) {
  return (
    <header
      data-testid="assistant-surface-actions"
      className="relative z-[70] flex min-h-16 shrink-0 items-center gap-3 border-b border-zinc-800/90 bg-zinc-950/98 px-3 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))]"
    >
      <h1 className="min-w-0 flex-1 truncate text-base font-semibold text-zinc-100">
        Add Message
      </h1>
      <button
        type="button"
        onClick={onOpenEvogent}
        disabled={!bridgeReady}
        data-testid="assistant-open-evogent"
        className="inline-flex min-h-12 items-center justify-center rounded-full border border-sky-400/35 bg-sky-500/12 px-4 text-sm font-medium text-sky-100 transition active:scale-95 disabled:cursor-wait disabled:border-zinc-700 disabled:bg-zinc-900 disabled:text-zinc-500"
      >
        Open Evogent
      </button>
      <button
        type="button"
        onClick={onClose}
        disabled={!bridgeReady}
        data-testid="assistant-close"
        aria-label="Close Add Message"
        className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-zinc-700 bg-zinc-900 text-zinc-200 transition active:scale-95 disabled:cursor-wait disabled:text-zinc-600"
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5">
          <path
            d="M6 6l12 12M18 6 6 18"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeWidth="2"
          />
        </svg>
      </button>
    </header>
  );
}
