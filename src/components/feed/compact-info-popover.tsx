'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

interface CompactInfoPopoverProps {
  title: string;
  children: ReactNode;
  buttonLabel?: string;
  align?: 'left' | 'right';
  panelClassName?: string;
  triggerVariant?: 'badge' | 'minimal';
}

export function CompactInfoPopover({
  title,
  children,
  buttonLabel = `View ${title.toLowerCase()}`,
  align = 'right',
  panelClassName = '',
  triggerVariant = 'badge',
}: CompactInfoPopoverProps) {
  const [open, setOpen] = useState(false);
  const popoverId = useId();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const isMinimalTrigger = triggerVariant === 'minimal';

  useEffect(() => {
    if (!open) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (containerRef.current?.contains(event.target as Node)) {
        return;
      }
      setOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [open]);

  return (
    <div ref={containerRef} className={isMinimalTrigger ? 'contents' : 'relative inline-flex shrink-0'}>
      <button
        type="button"
        aria-label={buttonLabel}
        aria-expanded={open}
        aria-controls={popoverId}
        onClick={() => setOpen((current) => !current)}
        className={isMinimalTrigger
          ? 'ml-0.5 -my-1.5 -mr-1.5 inline-flex items-center justify-center rounded-sm p-1.5 align-[-0.08em] text-zinc-400 transition-colors hover:text-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/70'
          : 'inline-flex h-8 w-8 items-center justify-center rounded-full border border-zinc-700/80 bg-zinc-900/60 text-zinc-300 transition-colors hover:border-zinc-500 hover:bg-zinc-900 hover:text-zinc-100'}
      >
        {isMinimalTrigger ? (
          <svg aria-hidden="true" viewBox="0 0 12 12" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M6 5.25v3.5" strokeLinecap="round" />
            <circle cx="6" cy="3.25" r="0.7" fill="currentColor" stroke="none" />
          </svg>
        ) : (
          <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
            <circle cx="10" cy="10" r="6.5" />
            <path d="M10 8.25v5" strokeLinecap="round" />
            <circle cx="10" cy="5.75" r="0.9" fill="currentColor" stroke="none" />
          </svg>
        )}
      </button>

      {open ? (
        <div
          id={popoverId}
          role="dialog"
          aria-label={title}
          className={`absolute top-[calc(100%+0.5rem)] z-30 rounded-2xl border border-zinc-700/80 bg-zinc-950/98 p-3 text-left shadow-2xl ${isMinimalTrigger ? 'left-0 right-0 w-auto' : `w-72 ${align === 'left' ? 'left-0' : 'right-0'}`} ${panelClassName}`}
        >
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-zinc-300">{title}</p>
          <div className="mt-2 space-y-2 text-sm leading-5 text-zinc-200">
            {children}
          </div>
        </div>
      ) : null}
    </div>
  );
}
