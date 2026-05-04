export const SEARCH_HIGHLIGHT_SELECTOR = '[data-search-highlight="true"], .search-match';

export function scrollSearchHighlightIntoView(root: ParentNode | null): boolean {
  const target = root?.querySelector<HTMLElement>(SEARCH_HIGHLIGHT_SELECTOR) ?? null;
  if (!target || typeof target.scrollIntoView !== 'function') {
    return false;
  }

  target.scrollIntoView({ block: 'center', behavior: 'auto' });
  return true;
}
