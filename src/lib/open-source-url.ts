/**
 * Open a card's source URL in its native app, reliably.
 *
 * The Android shell injects window.EvogentShell.openExternal(url), which runs the same
 * deterministic app-routing as a link navigation (X, Gmail, Instagram, YouTube, browser).
 * We prefer it because plain window.open('_blank') in a WebView goes through onCreateWindow and
 * is flaky. On the plain web build the bridge is absent, so we fall back to window.open.
 * This is the single tap-through path every card uses,
 * so "tap the card → see the thing in its app" works the same everywhere.
 */
export function openSourceUrl(url: string | null | undefined): boolean {
  const href = url?.trim();
  if (!href) return false;
  if (typeof window === 'undefined') return false;
  const shell = (window as typeof window & {
    EvogentShell?: { openExternal?: (u: string) => void };
  }).EvogentShell;
  if (shell && typeof shell.openExternal === 'function') {
    shell.openExternal(href);
    return true;
  }
  window.open(href, '_blank', 'noopener,noreferrer');
  return true;
}
