import { isScrollNearBottom } from '@/lib/chat-progress-view';
import { type RefObject } from 'react';

export function moveCaretToEnd(element: HTMLElement) {
  const selection = window.getSelection();
  if (!selection) return;

  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

export function insertPlainTextIntoContentEditable(element: HTMLElement, text: string) {
  const selection = window.getSelection();
  const activeRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  const range = activeRange && element.contains(activeRange.commonAncestorContainer)
    ? activeRange
    : document.createRange();

  if (!activeRange || !element.contains(activeRange.commonAncestorContainer)) {
    range.selectNodeContents(element);
    range.collapse(false);
  }

  range.deleteContents();

  const textNode = document.createTextNode(text);
  range.insertNode(textNode);

  range.setStartAfter(textNode);
  range.collapse(true);

  selection?.removeAllRanges();
  selection?.addRange(range);
}

export function updateNearBottomRef(
  container: HTMLDivElement | null,
  nearBottomRef: { current: boolean },
  onChange?: ((isNearBottom: boolean) => void) | null,
) {
  if (!container) {
    nearBottomRef.current = true;
    onChange?.(true);
    return;
  }

  nearBottomRef.current = isScrollNearBottom({
    scrollHeight: container.scrollHeight,
    scrollTop: container.scrollTop,
    clientHeight: container.clientHeight,
  });
  onChange?.(nearBottomRef.current);
}

export function scheduleScrollToBottom(
  containerRef: RefObject<HTMLDivElement | null>,
  nearBottomRef: { current: boolean },
  behavior: ScrollBehavior = 'auto',
  deferredFrames = 1,
  onChange?: ((isNearBottom: boolean) => void) | null,
) {
  const scrollToBottom = () => {
    const container = containerRef.current;
    if (!container) return;
    nearBottomRef.current = true;
    onChange?.(true);
    container.scrollTo({ top: container.scrollHeight, behavior });
  };

  const scroll = (remainingFrames: number) => {
    if (remainingFrames > 0) {
      requestAnimationFrame(() => scroll(remainingFrames - 1));
      return;
    }

    scrollToBottom();
  };

  scroll(deferredFrames);
}
