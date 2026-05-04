export const CHAT_AUTO_SCROLL_THRESHOLD_PX = 50;

export function isScrollNearBottom({
  scrollHeight,
  scrollTop,
  clientHeight,
}: {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}, thresholdPx = CHAT_AUTO_SCROLL_THRESHOLD_PX): boolean {
  if (!Number.isFinite(scrollHeight) || !Number.isFinite(scrollTop) || !Number.isFinite(clientHeight)) {
    return true;
  }

  return scrollHeight - scrollTop - clientHeight <= thresholdPx;
}
