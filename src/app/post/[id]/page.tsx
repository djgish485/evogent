'use client';

import { useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import type { FeedItem } from '@/types/feed';
import { PostDetailView } from '@/components/feed/post-detail-view';

export default function PostPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const routeId = Array.isArray(params.id) ? params.id[0] : params.id;

  const handleClose = useCallback(() => {
    if (window.history.length > 1) {
      router.back();
      return;
    }
    router.push('/');
  }, [router]);

  const handleChatAboutPost = useCallback((item: FeedItem, selectedText?: string) => {
    const query = new URLSearchParams();
    query.set('chatAbout', item.id);

    const trimmedSelectedText = selectedText?.trim();
    if (trimmedSelectedText) {
      query.set('chatSelection', trimmedSelectedText);
    }

    router.push(`/?${query.toString()}`);
  }, [router]);

  return (
    <PostDetailView
      routeId={routeId}
      backLabel="Back"
      onClose={handleClose}
      onChatAboutPost={handleChatAboutPost}
    />
  );
}
