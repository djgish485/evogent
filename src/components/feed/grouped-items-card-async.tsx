'use client';

import { GroupedItemsCard, type GroupedItemsCardProps } from './grouped-items-card';
import type { FeedItem } from '@/types/feed';

type AsyncGroupedItemsCardProps = Omit<GroupedItemsCardProps, 'summary' | 'items'> & {
  items: FeedItem[];
};

export function AsyncGroupedItemsCard({
  items,
  ...cardProps
}: AsyncGroupedItemsCardProps) {
  return (
    <GroupedItemsCard
      {...cardProps}
      items={items}
      summary=""
    />
  );
}
