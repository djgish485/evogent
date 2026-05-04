'use client';

import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

interface TextSelectionTooltipProps {
  agentName: string;
  containerRef: RefObject<HTMLElement | null>;
  onAskAgent?: (selectedText: string) => void;
}

interface TooltipState {
  anchorX: number;
  anchorY: number;
  selectedText: string;
}

const MIN_SELECTION_LENGTH = 3;
const TOOLTIP_VERTICAL_GAP_PX = 10;
const TOOLTIP_VIEWPORT_PADDING_PX = 8;
const TOOLTIP_HORIZONTAL_PADDING_PX = 8;
const SELECTION_STABLE_DELAY_MS = 350;
const SELECTION_RELEASE_DELAY_MS = 150;
const TOOLTIP_DISMISS_DELAY_MS = 100;

function getElementFromNode(node: Node | null): Element | null {
  if (!node) return null;
  return node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
}

function eventOccurredWithinNode(event: Event, node: Node | null): boolean {
  if (!node) return false;

  if (typeof event.composedPath === 'function') {
    return event.composedPath().includes(node);
  }

  return event.target instanceof Node && node.contains(event.target);
}

export function TextSelectionTooltip({
  agentName,
  containerRef,
  onAskAgent,
}: TextSelectionTooltipProps) {
  const tooltipRef = useRef<HTMLButtonElement | null>(null);
  const tooltipStateRef = useRef<TooltipState | null>(null);
  const showTimerRef = useRef<number | null>(null);
  const dismissTimerRef = useRef<number | null>(null);
  const isTooltipPressActiveRef = useRef(false);
  const suppressClickAfterPointerUpRef = useRef(false);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);

  const setTooltipIfChanged = useCallback((nextTooltip: TooltipState | null) => {
    const previousTooltip = tooltipStateRef.current;
    const hasChanged = previousTooltip?.anchorX !== nextTooltip?.anchorX
      || previousTooltip?.anchorY !== nextTooltip?.anchorY
      || previousTooltip?.selectedText !== nextTooltip?.selectedText;

    if (!hasChanged) {
      return;
    }

    tooltipStateRef.current = nextTooltip;
    setTooltip(nextTooltip);
  }, []);

  const clearShowTimer = useCallback(() => {
    if (showTimerRef.current === null) {
      return;
    }

    window.clearTimeout(showTimerRef.current);
    showTimerRef.current = null;
  }, []);

  const clearDismissTimer = useCallback(() => {
    if (dismissTimerRef.current === null) {
      return;
    }

    window.clearTimeout(dismissTimerRef.current);
    dismissTimerRef.current = null;
  }, []);

  const hideTooltip = useCallback(() => {
    clearShowTimer();
    setTooltipIfChanged(null);
  }, [clearShowTimer, setTooltipIfChanged]);

  const clearTooltip = useCallback(() => {
    clearDismissTimer();
    hideTooltip();
  }, [clearDismissTimer, hideTooltip]);

  const scheduleTooltipDismiss = useCallback((delayMs = TOOLTIP_DISMISS_DELAY_MS) => {
    if (isTooltipPressActiveRef.current) {
      return;
    }

    clearDismissTimer();
    dismissTimerRef.current = window.setTimeout(() => {
      dismissTimerRef.current = null;
      hideTooltip();
    }, delayMs);
  }, [clearDismissTimer, hideTooltip]);

  useLayoutEffect(() => {
    const tooltipElement = tooltipRef.current;
    if (!tooltip || !tooltipElement) return;

    const halfWidth = tooltipElement.offsetWidth / 2;
    const minLeft = halfWidth + TOOLTIP_HORIZONTAL_PADDING_PX;
    const viewportWidth = window.innerWidth;
    const maxLeft = viewportWidth - halfWidth - TOOLTIP_HORIZONTAL_PADDING_PX;
    const tooltipHeight = tooltipElement.offsetHeight;
    const minTop = tooltipHeight + TOOLTIP_VIEWPORT_PADDING_PX;
    const maxTop = window.innerHeight - TOOLTIP_VIEWPORT_PADDING_PX;
    const left = maxLeft <= minLeft
      ? viewportWidth / 2
      : Math.min(Math.max(tooltip.anchorX, minLeft), maxLeft);
    const top = maxTop <= minTop
      ? Math.max(TOOLTIP_VIEWPORT_PADDING_PX, window.innerHeight / 2)
      : Math.min(Math.max(tooltip.anchorY, minTop), maxTop);

    tooltipElement.style.left = `${left}px`;
    tooltipElement.style.top = `${top}px`;
    tooltipElement.classList.remove('opacity-100', 'translate-y-0');
    tooltipElement.classList.add('opacity-0', 'translate-y-1');

    const frame = window.requestAnimationFrame(() => {
      tooltipElement.classList.remove('opacity-0', 'translate-y-1');
      tooltipElement.classList.add('opacity-100', 'translate-y-0');
    });

    return () => window.cancelAnimationFrame(frame);
  }, [tooltip]);

  useEffect(() => {
    if (!onAskAgent) return;

    const getTooltipState = (): TooltipState | null => {
      const container = containerRef.current;
      const selection = window.getSelection();

      if (!container || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
        return null;
      }

      const selectionScope = container.closest('[data-testid="content-card"]') as HTMLElement | null ?? container;
      const selectedText = selection.toString().trim();
      if (selectedText.length < MIN_SELECTION_LENGTH) {
        return null;
      }

      const range = selection.getRangeAt(0);
      const startElement = getElementFromNode(range.startContainer);
      const endElement = getElementFromNode(range.endContainer);
      if (!startElement || !endElement || !selectionScope.contains(startElement) || !selectionScope.contains(endElement)) {
        return null;
      }

      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        return null;
      }

      return {
        anchorX: rect.left + (rect.width / 2),
        anchorY: rect.top - TOOLTIP_VERTICAL_GAP_PX,
        selectedText,
      };
    };

    const scheduleTooltipUpdate = (delayMs: number) => {
      clearDismissTimer();
      const nextTooltip = getTooltipState();
      if (!nextTooltip) {
        clearTooltip();
        return;
      }

      clearShowTimer();
      setTooltipIfChanged(null);

      showTimerRef.current = window.setTimeout(() => {
        showTimerRef.current = null;
        setTooltipIfChanged(getTooltipState());
      }, delayMs);
    };

    const dismissOnOutsidePress = (event: Event) => {
      if (eventOccurredWithinNode(event, containerRef.current)) return;
      if (eventOccurredWithinNode(event, tooltipRef.current)) return;
      scheduleTooltipDismiss();
    };

    const dismissOnScroll = () => {
      scheduleTooltipDismiss();
    };

    const handleSelectionChange = () => {
      scheduleTooltipUpdate(SELECTION_STABLE_DELAY_MS);
    };

    const handleSelectionEnd = () => {
      scheduleTooltipUpdate(SELECTION_RELEASE_DELAY_MS);
    };

    document.addEventListener('selectionchange', handleSelectionChange);
    document.addEventListener('mouseup', handleSelectionEnd, true);
    document.addEventListener('touchend', handleSelectionEnd, true);
    document.addEventListener('pointerdown', dismissOnOutsidePress, true);
    document.addEventListener('touchstart', dismissOnOutsidePress, true);
    window.addEventListener('resize', clearTooltip);
    window.addEventListener('scroll', dismissOnScroll, true);

    return () => {
      clearShowTimer();
      clearDismissTimer();
      document.removeEventListener('selectionchange', handleSelectionChange);
      document.removeEventListener('mouseup', handleSelectionEnd, true);
      document.removeEventListener('touchend', handleSelectionEnd, true);
      document.removeEventListener('pointerdown', dismissOnOutsidePress, true);
      document.removeEventListener('touchstart', dismissOnOutsidePress, true);
      window.removeEventListener('resize', clearTooltip);
      window.removeEventListener('scroll', dismissOnScroll, true);
    };
  }, [clearDismissTimer, clearShowTimer, clearTooltip, containerRef, hideTooltip, onAskAgent, scheduleTooltipDismiss, setTooltipIfChanged]);

  if (!onAskAgent || !tooltip) {
    return null;
  }

  return (
    <div className="pointer-events-none fixed inset-0 z-[9999] overflow-visible">
      <button
        ref={tooltipRef}
        type="button"
        data-testid="selection-discuss-button"
        aria-label={`Discuss with ${agentName}`}
        className="pointer-events-auto fixed rounded-lg border border-zinc-600 bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-100 opacity-0 shadow-xl transition-all duration-150 ease-out translate-y-1"
        style={{
          left: tooltip.anchorX,
          top: tooltip.anchorY,
          transform: 'translate(-50%, -100%)',
        }}
        onPointerDown={(event) => {
          isTooltipPressActiveRef.current = true;
          suppressClickAfterPointerUpRef.current = false;
          if (dismissTimerRef.current !== null) {
            window.clearTimeout(dismissTimerRef.current);
            dismissTimerRef.current = null;
          }
          event.preventDefault();
          event.stopPropagation();
        }}
        onPointerUp={(event) => {
          if (!isTooltipPressActiveRef.current) return;

          isTooltipPressActiveRef.current = false;
          suppressClickAfterPointerUpRef.current = true;
          event.preventDefault();
          event.stopPropagation();
          onAskAgent(tooltip.selectedText);
          clearTooltip();
          window.getSelection()?.removeAllRanges();
        }}
        onPointerCancel={() => {
          isTooltipPressActiveRef.current = false;
          suppressClickAfterPointerUpRef.current = false;
        }}
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (suppressClickAfterPointerUpRef.current) {
            suppressClickAfterPointerUpRef.current = false;
            return;
          }
          onAskAgent(tooltip.selectedText);
          clearTooltip();
          window.getSelection()?.removeAllRanges();
        }}
      >
        <span className="flex items-center gap-1.5">
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          <span>Discuss with {agentName}</span>
        </span>
        <span
          aria-hidden="true"
          className="absolute bottom-0 left-1/2 h-2.5 w-2.5 -translate-x-1/2 translate-y-1/2 rotate-45 border-r border-b border-zinc-600 bg-zinc-800"
        />
      </button>
    </div>
  );
}
