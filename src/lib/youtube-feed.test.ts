import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildYouTubeFeedMetadata, getYouTubeFeedData } from './youtube-feed';

describe('youtube-feed', () => {
  test('normalizes YouTube view count fields from metadata', () => {
    const video = getYouTubeFeedData({
      source: 'youtube',
      sourceId: 'video-123',
      url: 'https://www.youtube.com/watch?v=video-123',
      title: null,
      text: 'Example video',
      authorUsername: '@example',
      authorDisplayName: 'Example Channel',
      metadata: {
        title: 'Example video',
        channelName: 'Example Channel',
        channelHandle: '@example',
        thumbnailUrl: 'https://i.ytimg.com/vi/video-123/hqdefault.jpg',
        publishDateText: '13 hours ago',
        viewCount: 1700,
        viewCountText: '1.7K views',
      },
      mediaUrls: ['https://i.ytimg.com/vi/video-123/hqdefault.jpg'],
    });

    assert.ok(video);
    assert.equal(video?.viewCount, 1700);
    assert.equal(video?.viewCountText, '1.7K views');
  });

  test('buildYouTubeFeedMetadata preserves view count fields', () => {
    const metadata = buildYouTubeFeedMetadata({
      videoId: 'video-123',
      canonicalUrl: 'https://www.youtube.com/watch?v=video-123',
      title: 'Example video',
      description: null,
      channelName: 'Example Channel',
      channelHandle: '@example',
      channelUrl: 'https://www.youtube.com/@example',
      thumbnailUrl: 'https://i.ytimg.com/vi/video-123/hqdefault.jpg',
      publishDate: null,
      publishDateText: '13 hours ago',
      viewCount: 1700,
      viewCountText: '1.7K views',
      duration: '12:34',
      durationSeconds: 754,
      liveStatus: null,
      scheduledStartAt: null,
      scheduledStartText: null,
    });

    assert.equal(metadata.viewCount, 1700);
    assert.equal(metadata.viewCountText, '1.7K views');
    assert.equal((metadata.article as Record<string, unknown>).viewCount, 1700);
    assert.equal((metadata.article as Record<string, unknown>).viewCountText, '1.7K views');
  });
});
