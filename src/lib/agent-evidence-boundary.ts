import type { FeedItem } from '@/types/feed';

const DIRECT_PHONE_SESSION_SCHEME = 'EvogentSession ';

/**
 * The phone's mutually authenticated direct session is issued to evo-curl and
 * consumed once. Runtime workers use that direct client; the authenticated
 * WebView uses a distinct HTTPS-only HttpOnly web-session cookie.
 */
export function isRuntimeAgentEvidenceRequest(request: Request): boolean {
  const authorization = request.headers.get('authorization') ?? '';
  if (authorization.startsWith(DIRECT_PHONE_SESSION_SCHEME)) {
    return true;
  }

  // Server-owned callers can opt into the same narrow view explicitly. This is
  // useful for deterministic tests and internal evidence assembly, but user
  // browsers never need to set it.
  return new URL(request.url).searchParams.get('agentEvidence') === '1';
}

export function isPhoneNotificationFeedItem(
  item: { type?: string | null; source?: string | null } | null | undefined,
): boolean {
  return item?.type === 'notification' && item.source === 'phone-notification';
}

function sanitizeNestedItem(item: FeedItem): FeedItem | null {
  if (isPhoneNotificationFeedItem(item)) return null;
  const originalParentItem = item.parentItem ?? null;
  const parentItem = originalParentItem ? sanitizeNestedItem(originalParentItem) : null;
  const parentWasFiltered = originalParentItem !== null && parentItem === null;
  const children = (item.children ?? [])
    .filter((child) => !isPhoneNotificationFeedItem(child));
  const suggestionChildren = (item.suggestionChildren ?? [])
    .map(sanitizeNestedItem)
    .filter((child): child is FeedItem => child !== null);

  return {
    ...item,
    parentId: parentWasFiltered ? null : item.parentId,
    relationship: parentWasFiltered ? null : item.relationship,
    parentItem,
    children,
    childrenCount: children.length,
    suggestionChildren,
  };
}

/**
 * Filtering the SQL root rows is not enough: list/detail hydration can attach a
 * parent or child object. Apply the same boundary transitively immediately
 * before any runtime-agent JSON serialization.
 */
export function filterPhoneNotificationAgentEvidence(items: FeedItem[]): FeedItem[] {
  return items
    .map(sanitizeNestedItem)
    .filter((item): item is FeedItem => item !== null);
}
