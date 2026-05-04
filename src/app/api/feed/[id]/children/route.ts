import { NextResponse } from 'next/server';
import {
  getFeedChildren,
  getInteractionStates,
  getSuggestionStates,
  groupFeedChildrenByRelationship,
  hydrateFeedItemsForList,
  resolveFeedItemByIdentifier,
} from '@/lib/db/feed';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const item = resolveFeedItemByIdentifier(id);

  if (!item) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const children = getFeedChildren(item.id);
  const hydratedItems = hydrateFeedItemsForList([item, ...children]);
  const hydratedParent = hydratedItems.find((entry) => entry.id === item.id) ?? item;
  const hydratedChildren = hydratedItems.filter((entry) => entry.id !== item.id);
  const interactionStates = getInteractionStates([item.id, ...hydratedChildren.map((child) => child.id)]);
  const suggestionStates = getSuggestionStates([item.id, ...hydratedChildren.map((child) => child.id)]);

  const likedChildren = hydratedChildren.map((child) => ({
    ...child,
    isLiked: interactionStates[child.id]?.liked ?? false,
    isDisliked: interactionStates[child.id]?.disliked ?? false,
    suggestionStatus: child.type === 'suggestion' || child.type === 'notification'
      ? suggestionStates[child.id] ?? 'pending'
      : undefined,
  }));

  return NextResponse.json({
    parent: {
      ...hydratedParent,
      isLiked: interactionStates[item.id]?.liked ?? false,
      isDisliked: interactionStates[item.id]?.disliked ?? false,
      suggestionStatus: hydratedParent.type === 'suggestion' || hydratedParent.type === 'notification'
        ? suggestionStates[item.id] ?? 'pending'
        : undefined,
    },
    children: likedChildren,
    grouped: groupFeedChildrenByRelationship(likedChildren),
  });
}
