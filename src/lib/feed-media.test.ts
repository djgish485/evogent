import assert from 'node:assert/strict';
import test from 'node:test';
import { getFeedMediaItems, getFeedMediaUrlsAndTypes, getPreferredFeedMediaItems } from '@/lib/feed-media';

test('getFeedMediaUrlsAndTypes returns thumbnail urls for videos and gifs', () => {
  const payload = getFeedMediaUrlsAndTypes([
    { type: 'video', url: 'https://video.twimg.com/video.mp4', posterUrl: 'https://pbs.twimg.com/video-thumb.jpg' },
    { type: 'gif', url: 'https://video.twimg.com/animated.mp4', posterUrl: 'https://pbs.twimg.com/gif-thumb.jpg' },
    { type: 'image', url: 'https://pbs.twimg.com/photo.jpg' },
  ]);

  assert.deepStrictEqual(payload, {
    mediaUrls: [
      'https://pbs.twimg.com/video-thumb.jpg',
      'https://pbs.twimg.com/gif-thumb.jpg',
      'https://pbs.twimg.com/photo.jpg',
    ],
    mediaTypes: ['video', 'animated_gif', 'photo'],
  });
});

test('getFeedMediaItems maps mediaTypes to displayable media entries', () => {
  const media = getFeedMediaItems({
    mediaUrls: [
      'https://pbs.twimg.com/video-thumb.jpg',
      'https://pbs.twimg.com/photo.jpg',
      'https://pbs.twimg.com/gif-thumb.jpg',
    ],
    metadata: {
      mediaTypes: ['video', 'photo', 'animated_gif'],
    },
  });

  assert.deepStrictEqual(media, [
    { type: 'video', url: 'https://pbs.twimg.com/video-thumb.jpg' },
    { type: 'image', url: 'https://pbs.twimg.com/photo.jpg' },
    { type: 'gif', url: 'https://pbs.twimg.com/gif-thumb.jpg' },
  ]);
});

test('getFeedMediaItems prefers rich metadata.media entries when present', () => {
  const media = getFeedMediaItems({
    mediaUrls: ['https://pbs.twimg.com/photo.jpg'],
    metadata: {
      mediaTypes: ['photo'],
      media: [
        {
          type: 'video',
          url: 'https://pbs.twimg.com/video-thumb.jpg',
          videoUrl: 'https://video.twimg.com/video.mp4',
        },
      ],
    },
  });

  assert.deepStrictEqual(media, [
    {
      type: 'video',
      url: 'https://pbs.twimg.com/video-thumb.jpg',
      videoUrl: 'https://video.twimg.com/video.mp4',
    },
  ]);
});

test('getPreferredFeedMediaItems falls back to inherited analysis hero media', () => {
  const media = getPreferredFeedMediaItems({
    mediaUrls: [],
    metadata: null,
    analysisPresentation: {
      conciseTitle: 'Agent analysis',
      conciseLabel: 'Agent analysis',
      promotionScore: 4,
      seriesKey: 'analysis-series:parent-1',
      seriesLabel: 'Parent',
      heroMedia: [
        {
          type: 'image',
          url: 'https://example.com/hero.jpg',
        },
      ],
      heroMediaSource: null,
      sourceItems: [],
    },
  });

  assert.deepStrictEqual(media, [
    {
      type: 'image',
      url: 'https://example.com/hero.jpg',
    },
  ]);
});
