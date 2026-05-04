import type { FeedItem, FeedMediaType, FeedMetadata, MediaItem } from '@/types/feed';

export function feedMediaTypeFromMediaItemType(type: MediaItem['type']): FeedMediaType {
  switch (type) {
    case 'video':
      return 'video';
    case 'gif':
      return 'animated_gif';
    case 'image':
    default:
      return 'photo';
  }
}

export function mediaItemTypeFromFeedMediaType(type: string | null | undefined): MediaItem['type'] {
  const normalized = typeof type === 'string' ? type.trim().toLowerCase() : '';

  if (normalized === 'video') {
    return 'video';
  }

  if (normalized === 'animated_gif' || normalized === 'gif') {
    return 'gif';
  }

  return 'image';
}

export function getMediaThumbnailUrl(media: Pick<MediaItem, 'url' | 'posterUrl'>): string {
  return media.posterUrl || media.url;
}

export function getFeedMediaUrlsAndTypes(media: MediaItem[]): {
  mediaUrls: string[];
  mediaTypes: FeedMediaType[];
} {
  return {
    mediaUrls: media.map((entry) => getMediaThumbnailUrl(entry)),
    mediaTypes: media.map((entry) => feedMediaTypeFromMediaItemType(entry.type)),
  };
}

export function getFeedMediaItems(item: Pick<FeedItem, 'mediaUrls' | 'metadata'>): MediaItem[] {
  if (Array.isArray(item.metadata?.media) && item.metadata.media.length > 0) {
    return item.metadata.media;
  }

  if (!Array.isArray(item.mediaUrls) || item.mediaUrls.length === 0) {
    return [];
  }

  const mediaTypes = item.metadata?.mediaTypes ?? [];

  return item.mediaUrls.map((url, index) => ({
    type: mediaItemTypeFromFeedMediaType(mediaTypes[index]),
    url,
  }));
}

export function getPreferredFeedMediaItems(item: Pick<FeedItem, 'mediaUrls' | 'metadata' | 'analysisPresentation'>): MediaItem[] {
  const directMedia = getFeedMediaItems(item);
  if (directMedia.length > 0) {
    return directMedia;
  }

  if (Array.isArray(item.analysisPresentation?.heroMedia) && item.analysisPresentation.heroMedia.length > 0) {
    return item.analysisPresentation.heroMedia;
  }

  return [];
}

export function getDerivedFeedMediaTypes(metadata: FeedMetadata | null): FeedMediaType[] {
  if (Array.isArray(metadata?.mediaTypes) && metadata.mediaTypes.length > 0) {
    return metadata.mediaTypes;
  }

  if (Array.isArray(metadata?.media) && metadata.media.length > 0) {
    return metadata.media.map((entry) => feedMediaTypeFromMediaItemType(entry.type));
  }

  return [];
}
