import { type FeedItem } from '@/types/feed';

export type NotificationFeedItem = FeedItem & {
  type: 'notification';
};

export function isDismissedNotification(item: FeedItem): boolean {
  return item.type === 'notification' && item.suggestionStatus === 'dismissed';
}

export function isExpiredNotification(item: FeedItem): boolean {
  if (item.type !== 'notification') return false;
  const expiresAt = typeof item.metadata?.expiresAt === 'string' ? Date.parse(item.metadata.expiresAt) : Number.NaN;
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

export function isActiveNotification(item: FeedItem): boolean {
  return item.type === 'notification' && !isDismissedNotification(item) && !isExpiredNotification(item);
}

export function getNotificationGroupTitle(): string {
  return 'Notifications';
}
