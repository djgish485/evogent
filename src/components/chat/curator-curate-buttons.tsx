import { type CurateCommand } from '@/lib/brain-provider';
import { CURATOR_CURATE_BUTTON_BASE_CLASS_NAME, CURATOR_CURATE_COMMANDS, CURATOR_CURATE_FULL_LABEL_MIN_ROW_WIDTH, getCuratorCurateButtonIconStyle, getCuratorCurateButtonStyle, type SessionTint } from '@/lib/session-tints';
import { type MouseEvent as ReactMouseEvent, useLayoutEffect, useRef, useState } from 'react';

export function CuratorCurateButtons({
  disabled,
  tint,
  showIcon = true,
  fullLabelMinRowWidth = CURATOR_CURATE_FULL_LABEL_MIN_ROW_WIDTH,
  className,
  onContainerClick,
  onSubmit,
}: {
  disabled: boolean;
  tint?: SessionTint;
  showIcon?: boolean;
  fullLabelMinRowWidth?: number;
  className?: string;
  onContainerClick?: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onSubmit: (command: CurateCommand) => void;
}) {
  const buttonStyle = getCuratorCurateButtonStyle(tint);
  const iconStyle = showIcon ? getCuratorCurateButtonIconStyle(tint) : undefined;
  const containerRef = useRef<HTMLDivElement>(null);
  const [showFullLatestLabel, setShowFullLatestLabel] = useState(false);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const row = container.closest<HTMLElement>('[data-curator-actions-row]')
      ?? container.parentElement
      ?? container;

    const updateLabelMode = () => {
      const nextShowFullLatestLabel = row.getBoundingClientRect().width >= fullLabelMinRowWidth;
      setShowFullLatestLabel((current) => (
        current === nextShowFullLatestLabel ? current : nextShowFullLatestLabel
      ));
    };

    updateLabelMode();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateLabelMode);
      return () => window.removeEventListener('resize', updateLabelMode);
    }

    const observer = new ResizeObserver(updateLabelMode);
    observer.observe(row);
    return () => observer.disconnect();
  }, [fullLabelMinRowWidth]);

  return (
    <div ref={containerRef} className={className} onClick={onContainerClick}>
      {CURATOR_CURATE_COMMANDS.map(({ command, label, mobileLabel }) => {
        const shouldUseFullLabel = command === '/curate-latest' && showFullLatestLabel;
        const displayedLabel = shouldUseFullLabel ? label : mobileLabel;
        const buttonSizeClassName = showIcon
          ? (
              shouldUseFullLabel
                ? 'w-auto gap-0.5 px-2.5 sm:gap-1.5'
                : 'w-auto min-w-[4.5rem] gap-0.5 px-1.5 sm:w-auto sm:gap-1'
            )
          : (
              shouldUseFullLabel
                ? 'w-auto px-2.5'
                : 'w-auto min-w-[4rem] px-2.5 sm:w-auto'
            );

        return (
          <button
            key={command}
            type="button"
            onClick={() => onSubmit(command)}
            disabled={disabled}
            aria-label={label}
            className={`${CURATOR_CURATE_BUTTON_BASE_CLASS_NAME} ${buttonSizeClassName}`}
            style={buttonStyle}
          >
            {showIcon ? (
              <span
                className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-md border opacity-80 transition group-hover:opacity-100"
                style={iconStyle}
              >
                <svg aria-hidden="true" viewBox="0 0 24 24" className="h-3 w-3">
                  <path
                    d="M4 12a8 8 0 0 1 13.66-5.66L20 8.68V4"
                    className="fill-none stroke-current"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="1.8"
                  />
                  <path
                    d="M20 12a8 8 0 0 1-13.66 5.66L4 15.32V20"
                    className="fill-none stroke-current"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="1.8"
                  />
                </svg>
              </span>
            ) : null}
            <span className="pt-px">{displayedLabel}</span>
          </button>
        );
      })}
    </div>
  );
}
