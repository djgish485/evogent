import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  ArticleCard,
  QuoteTweetCard,
  TweetCard,
  resolveAnalysisAuthorDisplayName,
  resolveAnalysisByline,
  resolveAnalysisDisplayTitle,
  resolveArticleHeaderDisplayName,
  resolveArticleHeaderSubline,
  getTweetLinkPreviews,
  resolveHackerNewsPoints,
  resolveOgDescriptionSubtitle,
  resolveContentCardOuterClass,
  resolveExternalOpenUrl,
  resolveSecondarySourceLink,
  resolveSourceDisplayLabel,
  resolveSourceOpenLabel,
  resolveYouTubeViewLabel,
  shouldRenderContentCardChildPreviews,
  shouldRenderContentCardParentTweetPreview,
  shouldTrackPassiveFeedView,
} from './content-card';
import type { FeedItem } from '@/types/feed';

function createAnalysisItem(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    id: 'analysis-1',
    type: 'analysis',
    source: 'claude',
    sourceId: 'analysis-1',
    parentId: null,
    relationship: 'analysis',
    title: 'Full analysis title that should remain visible on the standalone card',
    text: 'Analysis body',
    url: null,
    excerpt: null,
    authorUsername: null,
    authorDisplayName: null,
    reason: null,
    tags: [],
    mediaUrls: [],
    metrics: { likes: 0, reposts: 0, replies: 0 },
    authorAvatarUrl: null,
    isLiked: false,
    isDisliked: false,
    parentItem: null,
    children: [],
    childrenCount: 0,
    suggestionChildren: [],
    analysisPresentation: {
      conciseTitle: 'Shortened analysis title',
      conciseLabel: 'Shortened analysis title',
      promotionScore: 4,
      seriesKey: 'analysis-series:1',
      seriesLabel: 'Primary source story',
      heroMedia: [],
      heroMediaSource: null,
      sourceItems: [],
    },
    metadata: null,
    publishedAt: '2026-04-11T00:00:00.000Z',
    createdAt: '2026-04-11T00:00:00.000Z',
    ...overrides,
  };
}

function createArticleItem(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    id: 'article-1',
    type: 'article',
    source: 'substack',
    sourceId: 'article-1',
    parentId: null,
    relationship: null,
    title: 'Article title',
    text: 'Article body',
    url: 'https://example-publication.example.com/p/article',
    excerpt: 'Article excerpt',
    authorUsername: 'example_writer',
    authorDisplayName: null,
    reason: null,
    tags: [],
    mediaUrls: [],
    metrics: { likes: 0, reposts: 0, replies: 0 },
    authorAvatarUrl: null,
    isLiked: false,
    isDisliked: false,
    parentItem: null,
    children: [],
    childrenCount: 0,
    suggestionChildren: [],
    metadata: null,
    publishedAt: '2026-04-11T00:00:00.000Z',
    createdAt: '2026-04-11T00:00:00.000Z',
    ...overrides,
  };
}

function createTweetItem(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    id: 'tweet-1',
    type: 'tweet',
    source: 'twitter',
    sourceId: '1888990011223344550',
    parentId: null,
    relationship: null,
    title: null,
    text: 'Built an interactive demo in a browser tab.',
    url: 'https://x.com/example_author/status/1888990011223344550',
    excerpt: null,
    authorUsername: 'example_author',
    authorDisplayName: 'Example Author',
    reason: null,
    tags: [],
    mediaUrls: [],
    metrics: { likes: 0, reposts: 0, replies: 0 },
    authorAvatarUrl: null,
    isLiked: false,
    isDisliked: false,
    parentItem: null,
    children: [],
    childrenCount: 0,
    suggestionChildren: [],
    metadata: null,
    publishedAt: '2026-04-25T00:00:00.000Z',
    createdAt: '2026-04-25T00:00:00.000Z',
    ...overrides,
  };
}

function renderTweetCardMarkup(item: FeedItem): string {
  return renderToStaticMarkup(createElement(TweetCard, {
    item,
    agentName: 'Agent',
    showQuoteMetrics: false,
    isLiked: false,
    isDisliked: false,
    votePending: false,
    metricsLikes: 0,
    onThumbsUp: () => {},
    onThumbsDown: () => {},
    expanded: false,
    onToggleExpand: () => {},
    showReasonInput: null,
    onReasonSubmit: () => {},
    onDismissReasonInput: () => {},
    onImageClick: () => {},
    onQuoteTweetClick: () => {},
  }));
}

describe('freshness shipment explanations', () => {
  test('shows the runtime agent public reason on an explicit v1 shipment', () => {
    const reason = 'This reports a concrete result with useful implementation detail.';
    const item = createTweetItem({
      metadata: {
        freshnessFloor: true,
        interest: { score: 0.84, reason },
        shipment: {
          id: 'shipment-0123456789abcdef0123',
          decision: 'ship',
          rank: 0.84,
          reason,
        },
      },
    });

    const markup = renderTweetCardMarkup(item);
    assert.match(markup, /data-testid="feed-card-context-reason"/);
    assert.match(markup, /This reports a concrete result with useful implementation detail\./);
  });

  test('continues suppressing machine provenance on legacy floor rows', () => {
    const machineReason = 'Fresh twitter item from a deterministic fallback.';
    const item = createTweetItem({
      metadata: {
        freshnessFloor: true,
        interest: { score: 0.84, reason: machineReason },
      },
    });

    const markup = renderTweetCardMarkup(item);
    assert.doesNotMatch(markup, /Fresh twitter item from a deterministic fallback\./);
  });
});

describe('resolveAnalysisDisplayTitle', () => {
  test('prefers the full analysis title over the concise presentation title', () => {
    const item = createAnalysisItem();

    assert.equal(
      resolveAnalysisDisplayTitle(item),
      'Full analysis title that should remain visible on the standalone card',
    );
  });

  test('falls back to the concise presentation title when the full title is blank', () => {
    const item = createAnalysisItem({
      title: '   ',
      analysisPresentation: {
        conciseTitle: 'Shortened analysis title',
        conciseLabel: 'Shortened analysis title',
        promotionScore: 4,
        seriesKey: 'analysis-series:1',
        seriesLabel: 'Primary source story',
        heroMedia: [],
        heroMediaSource: null,
        sourceItems: [],
      },
    });

    assert.equal(resolveAnalysisDisplayTitle(item), 'Shortened analysis title');
  });
});

describe('resolveAnalysisAuthorDisplayName', () => {
  test('prefers item authorDisplayName over the global agent name', () => {
    const item = createAnalysisItem({
      authorDisplayName: "Bob's Solutions",
    });

    assert.equal(resolveAnalysisAuthorDisplayName(item, 'Bob'), "Bob's Solutions");
  });

  test('falls back to the global agent name when authorDisplayName is blank', () => {
    const item = createAnalysisItem({
      authorDisplayName: '   ',
    });

    assert.equal(resolveAnalysisAuthorDisplayName(item, 'Bob'), 'Bob');
  });
});

describe('resolveAnalysisByline', () => {
  test('uses item authorDisplayName directly when present', () => {
    const item = createAnalysisItem({
      authorDisplayName: "Bob's Solutions",
    });

    assert.equal(resolveAnalysisByline(item, 'Bob'), "Bob's Solutions");
  });

  test('falls back to the possessive agent byline when authorDisplayName is absent', () => {
    const item = createAnalysisItem();

    assert.equal(resolveAnalysisByline(item, 'Bob'), "Bob's analysis");
  });
});

describe('resolveArticleHeaderDisplayName', () => {
  test('prefers item authorDisplayName over the platform display name', () => {
    const item = createArticleItem({
      authorDisplayName: 'Import AI by Jack Clark',
      metadata: { authorName: 'Jack Clark' },
    });

    assert.equal(
      resolveArticleHeaderDisplayName(item, { displayName: 'Substack' }),
      'Import AI by Jack Clark',
    );
  });

  test('falls back to metadata.authorName before the platform display name', () => {
    const item = createArticleItem({
      metadata: { authorName: 'Jack Clark' },
    });

    assert.equal(
      resolveArticleHeaderDisplayName(item, { displayName: 'Substack' }),
      'Jack Clark',
    );
  });
});

describe('resolveArticleHeaderSubline', () => {
  test('prefers metadata authorHandle over the duplicated source label', () => {
    const item = createArticleItem({
      source: 'OpenClaw',
      metadata: { authorHandle: 'via Email skill' },
    });

    assert.equal(resolveArticleHeaderSubline(item), 'via Email skill');
  });
});

describe('resolveSourceOpenLabel', () => {
  test('maps supported sources to source-aware open labels', () => {
    assert.equal(resolveSourceOpenLabel('twitter'), 'Open on X');
    assert.equal(resolveSourceOpenLabel('hackernews'), 'Open on HN');
    assert.equal(resolveSourceOpenLabel('youtube'), 'Open on YouTube');
    assert.equal(resolveSourceOpenLabel('substack'), 'Open on Substack');
    assert.equal(resolveSourceOpenLabel('rss'), 'Open link');
  });
});

describe('resolveExternalOpenUrl (card tap-through target)', () => {
  test('tweet with a numeric status id → the exact tweet permalink', () => {
    const item = createTweetItem({
      sourceId: '1888990011223344556',
      authorUsername: 'author_one',
      url: 'https://x.com/author_one/status/1888990011223344556',
    });
    assert.equal(resolveExternalOpenUrl(item), 'https://x.com/author_one/status/1888990011223344556');
  });

  test('tweet-prefixed sourceId → permalink from handle + id', () => {
    const item = createTweetItem({
      sourceId: 'tweet-1888990011223344556',
      authorUsername: 'author_two',
      url: '',
    });
    assert.equal(resolveExternalOpenUrl(item), 'https://x.com/author_two/status/1888990011223344556');
  });

  test('phone-scraped tweet without a status id → author profile, NEVER an X search screen', () => {
    const item = createTweetItem({
      sourceId: 'phone-twitter-example-organization-update',
      authorUsername: 'example_org',
      text: 'The organization moved new hardware to its test site.',
      url: 'https://x.com/example_org',
    });
    // No status id was captured, so fall back to the author's profile rather than search.
    const url = resolveExternalOpenUrl(item);
    assert.strictEqual(url, 'https://x.com/example_org');
    assert.doesNotMatch(url ?? '', /\/search\?q=/);
  });

  test('phone-scraped tweet with no usable text → author profile fallback', () => {
    const item = createTweetItem({
      sourceId: 'phone-twitter-example-org',
      authorUsername: 'example_org',
      text: '',
      title: null,
      url: 'https://x.com/example_org',
    });
    assert.equal(resolveExternalOpenUrl(item), 'https://x.com/example_org');
  });

  test('phone-scraped tweet with an uncertain handle and no URL stays in-app', () => {
    const item = createTweetItem({
      sourceId: 'phone-twitter-display-name-provisional',
      authorUsername: 'display_name_guess',
      url: null,
      metadata: { handleUncertain: true },
    });
    assert.equal(resolveExternalOpenUrl(item), null);
  });

  test('uncertain handle cannot turn a forged profile URL into a card destination', () => {
    const item = createTweetItem({
      sourceId: 'phone-twitter-display-name-provisional',
      authorUsername: 'display_name_guess',
      url: 'https://x.com/display_name_guess',
      metadata: { handleUncertain: true },
    });
    assert.equal(resolveExternalOpenUrl(item), null);
  });

  test('an exact status id remains usable without trusting an uncertain handle', () => {
    const item = createTweetItem({
      sourceId: '1888990011223344556',
      authorUsername: 'display_name_guess',
      url: null,
      metadata: { handleUncertain: true },
    });
    assert.equal(resolveExternalOpenUrl(item), 'https://x.com/i/web/status/1888990011223344556');
  });

  test('article with a real page URL → that URL', () => {
    const item = createArticleItem({
      source: 'web',
      url: 'https://news.example.com/research/instrument-arrives/',
    });
    assert.equal(resolveExternalOpenUrl(item), 'https://news.example.com/research/instrument-arrives/');
  });

  test('youtube item with canonicalUrl → the watch URL', () => {
    const item = createArticleItem({
      source: 'youtube',
      url: '',
      metadata: { canonicalUrl: 'https://www.youtube.com/watch?v=a1B2c3D4e5F' } as FeedItem['metadata'],
    });
    assert.equal(resolveExternalOpenUrl(item), 'https://www.youtube.com/watch?v=a1B2c3D4e5F');
  });

  test('internal agent-authored article (no external web URL) → null, keeps in-app detail', () => {
    const item = createArticleItem({
      source: 'openclaw',
      url: 'internal://curation-analysis/which-system-can-change-course',
    });
    assert.equal(resolveExternalOpenUrl(item), null);
  });
});

describe('getTweetLinkPreviews', () => {
  test('renders an exact-cache linkCard through the tweet link preview path', () => {
    const item = createTweetItem({
      metadata: {
        linkCard: {
          type: 'article',
          url: 'https://code.example.com/example/project',
          title: 'Example code project',
          domain: 'github.com',
          imageUrl: 'https://images.example.com/project-card.png',
          imageAlt: 'Repository preview image',
          description: 'Interactive browser project.',
        },
      },
    });

    assert.deepEqual(getTweetLinkPreviews(item), [{
      url: 'https://code.example.com/example/project',
      title: 'Example code project',
      domain: 'github.com',
      image: 'https://images.example.com/project-card.png',
      imageAlt: 'Repository preview image',
      description: 'Interactive browser project.',
    }]);
  });
});

describe('detail duplicate suppression', () => {
  test('suppresses child previews when the card is the detail main item', () => {
    assert.equal(shouldRenderContentCardChildPreviews({
      itemId: 'main-tweet',
      detailMainItemId: 'main-tweet',
      hasChildPreviews: true,
    }), false);
  });

  test('keeps child previews when the card is not the detail main item', () => {
    assert.equal(shouldRenderContentCardChildPreviews({
      itemId: 'analysis-child',
      detailMainItemId: 'main-tweet',
      hasChildPreviews: true,
    }), true);
  });

  test('suppresses parent tweet previews when the parent is the detail main item', () => {
    const parentTweet = createTweetItem({ id: 'main-tweet' });

    assert.equal(
      shouldRenderContentCardParentTweetPreview(parentTweet, 'main-tweet'),
      false,
    );
  });

  test('keeps parent tweet previews when the parent is not the detail main item', () => {
    const parentTweet = createTweetItem({ id: 'other-tweet' });

    assert.equal(
      shouldRenderContentCardParentTweetPreview(parentTweet, 'main-tweet'),
      true,
    );
  });
});

describe('resolveContentCardOuterClass', () => {
  test('renders reply children on a detail screen without the outer card border treatment', () => {
    const className = resolveContentCardOuterClass({
      relationship: 'reply',
      detailMainItemId: 'main-tweet',
    });

    assert.match(className, /\bpx-4\b/);
    assert.match(className, /\bpy-3\b/);
    assert.doesNotMatch(className, /\brounded-2xl\b/);
    assert.doesNotMatch(className, /\bborder-zinc-700\b/);
    assert.doesNotMatch(className, /\bshadow-\[/);
    assert.doesNotMatch(className, /\bhover:border-zinc-600\b/);
  });

  test('keeps non-reply detail children in the bordered card treatment', () => {
    const className = resolveContentCardOuterClass({
      relationship: 'analysis',
      detailMainItemId: 'main-tweet',
    });

    assert.match(className, /\brounded-2xl\b/);
    assert.match(className, /\bborder-zinc-700\b/);
    assert.match(className, /\bshadow-\[/);
  });

  test('keeps reply cards bordered outside a detail screen', () => {
    const className = resolveContentCardOuterClass({
      relationship: 'reply',
      detailMainItemId: null,
    });

    assert.match(className, /\brounded-2xl\b/);
    assert.match(className, /\bborder-zinc-700\b/);
  });
});

describe('shouldTrackPassiveFeedView', () => {
  test('tracks only actual feed cards that are not waiting on enrichment', () => {
    assert.equal(shouldTrackPassiveFeedView({ detail: false, batchEnrichmentState: 'none' }), true);
    assert.equal(shouldTrackPassiveFeedView({ detail: false, batchEnrichmentState: 'complete' }), true);
    assert.equal(shouldTrackPassiveFeedView({ detail: true, batchEnrichmentState: 'complete' }), false);
    assert.equal(shouldTrackPassiveFeedView({ detail: false, batchEnrichmentState: 'enriching' }), false);
    assert.equal(shouldTrackPassiveFeedView({ detail: false, batchEnrichmentState: 'incomplete' }), false);
    assert.equal(shouldTrackPassiveFeedView({ detail: false, batchEnrichmentState: 'failed' }), false);
  });
});

describe('TweetCard community notes', () => {
  test('renders a main tweet community note as distinct Readers added context', () => {
    const item = createTweetItem({
      metadata: {
        communityNote: {
          text: 'This market applies to local, state, and national moratoriums.',
          sourceUrl: 'https://example.com/main-note-source',
        },
      },
    });

    const markup = renderToStaticMarkup(createElement(TweetCard, {
      item,
      agentName: 'Agent',
      showQuoteMetrics: false,
      isLiked: false,
      isDisliked: false,
      votePending: false,
      metricsLikes: 0,
      onThumbsUp: () => {},
      onThumbsDown: () => {},
      expanded: false,
      onToggleExpand: () => {},
      showReasonInput: null,
      onReasonSubmit: () => {},
      onDismissReasonInput: () => {},
      onImageClick: () => {},
      onQuoteTweetClick: () => {},
    }));

    assert.match(markup, /data-testid="tweet-community-note"/);
    assert.match(markup, /Readers added context/);
    assert.match(markup, /This market applies to local, state, and national moratoriums\./);
    assert.match(markup, /href="https:\/\/example\.com\/main-note-source"/);
  });

  test('renders a quoted tweet community note inside the quoted card', () => {
    const markup = renderToStaticMarkup(createElement(QuoteTweetCard, {
      quote: {
        id: 'quoted-1',
        text: 'Quoted tweet body',
        author: {
          username: 'example_market',
          displayName: 'Example Market',
        },
        communityNote: {
          text: 'The note is attached to the quoted tweet, not the parent author text.',
          sourceUrl: 'https://example.com/quoted-note-source',
        },
      },
    }));

    assert.match(markup, /data-testid="quoted-tweet-preview"/);
    assert.match(markup, /data-testid="tweet-community-note"/);
    assert.match(markup, /Readers added context/);
    assert.match(markup, /The note is attached to the quoted tweet, not the parent author text\./);
    assert.match(markup, /href="https:\/\/example\.com\/quoted-note-source"/);
  });

  test('highlights search matches inside quoted tweet previews', () => {
    const markup = renderToStaticMarkup(createElement(QuoteTweetCard, {
      quote: {
        id: 'quoted-1',
        text: 'Quoted tweet mentions vector search in the middle of the text.',
        author: {
          username: 'example_market',
          displayName: 'Example Market',
        },
      },
      searchQuery: 'vector',
    }));

    assert.match(markup, /data-testid="quoted-tweet-preview"/);
    assert.match(markup, /data-search-highlight="true"/);
    assert.match(markup, /search-match/);
    assert.match(markup, />vector</);
  });
});

describe('TweetCard visible Twitter metadata', () => {
  test('renders media alt text, link card image alt text, and poll metadata', () => {
    const item = createTweetItem({
      mediaUrls: ['https://pbs.twimg.com/media/example-turbine.jpg'],
      metadata: {
        media: [{
          type: 'image',
          url: 'https://pbs.twimg.com/media/example-turbine.jpg',
          alt: 'Industrial turbine in assembly',
        }],
        linkCard: {
          type: 'article',
          url: 'https://news.example.com/story',
          title: 'News card example',
          domain: 'news.example.com',
          imageUrl: 'https://images.example.com/news-card.jpg',
          imageAlt: 'News card image description',
        },
        poll: {
          options: [
            { label: 'Yes', voteCount: 60 },
            { label: 'No', voteCount: 40 },
          ],
          totalVotes: 100,
          durationMinutes: 30,
        },
      },
    });

    const markup = renderTweetCardMarkup(item);

    assert.match(markup, /alt="Industrial turbine in assembly"/);
    assert.match(markup, /alt="News card image description"/);
    assert.match(markup, /data-testid="tweet-poll"/);
    assert.match(markup, />Yes</);
    assert.match(markup, />No</);
    assert.match(markup, />100 votes/);
    assert.match(markup, /30m left/);
  });

  test('renders quoted tweet link cards and polls', () => {
    const markup = renderToStaticMarkup(createElement(QuoteTweetCard, {
      quote: {
        id: 'quoted-1',
        text: 'Quoted tweet body',
        author: {
          username: 'example_market',
          displayName: 'Example Market',
        },
        linkCard: {
          type: 'article',
          url: 'https://example.com/quoted-card',
          title: 'Quoted card',
          domain: 'example.com',
          imageUrl: 'https://example.com/quoted-card.jpg',
          imageAlt: 'Quoted card image',
        },
        poll: {
          options: [
            { label: 'Ship it', voteCount: 9 },
            { label: 'Wait', voteCount: 1 },
          ],
          totalVotes: 10,
          durationMinutes: 90,
        },
      },
    }));

    assert.match(markup, /data-testid="quoted-tweet-preview"/);
    assert.match(markup, />Quoted card</);
    assert.match(markup, /alt="Quoted card image"/);
    assert.match(markup, /data-testid="tweet-poll"/);
    assert.match(markup, />Ship it</);
    assert.match(markup, />10 votes/);
    assert.match(markup, /1h 30m left/);
  });
});

describe('TweetCard Hacker News points', () => {
  test('renders HN score separately from the local thumbs-up count', () => {
    const item = createTweetItem({
      source: 'hackernews',
      metrics: { likes: 365, reposts: 0, replies: 12 },
      metadata: {
        hackerNews: {
          score: 365,
        },
      },
    });

    const markup = renderToStaticMarkup(createElement(TweetCard, {
      item,
      agentName: 'Agent',
      showQuoteMetrics: false,
      isLiked: true,
      isDisliked: false,
      votePending: false,
      metricsLikes: 366,
      onThumbsUp: () => {},
      onThumbsDown: () => {},
      expanded: false,
      onToggleExpand: () => {},
      showReasonInput: null,
      onReasonSubmit: () => {},
      onDismissReasonInput: () => {},
      onImageClick: () => {},
      onQuoteTweetClick: () => {},
    }));

    assert.match(markup, /data-testid="hacker-news-points"/);
    assert.match(markup, />365 pts</);
    assert.doesNotMatch(markup, />366</);
  });
});

describe('resolveSourceDisplayLabel', () => {
  test('maps supported sources to readable display labels', () => {
    assert.equal(resolveSourceDisplayLabel('twitter'), 'X');
    assert.equal(resolveSourceDisplayLabel('hackernews'), 'Hacker News');
    assert.equal(resolveSourceDisplayLabel('youtube'), 'YouTube');
    assert.equal(resolveSourceDisplayLabel('substack'), 'Substack');
  });
});

describe('resolveSecondarySourceLink', () => {
  test('returns the HN discussion link for hacker news items', () => {
    const item = createArticleItem({
      source: 'hackernews',
      url: 'https://example.com/distributed-systems',
      metadata: {
        hnUrl: 'https://news.ycombinator.com/item?id=101',
      } as FeedItem['metadata'],
    });

    assert.deepEqual(resolveSecondarySourceLink(item), {
      href: 'https://news.ycombinator.com/item?id=101',
      label: 'HN Discussion',
    });
  });

  test('skips the secondary link when the HN URL matches the primary URL', () => {
    const item = createArticleItem({
      source: 'hackernews',
      url: 'https://news.ycombinator.com/item?id=101',
      metadata: {
        hnUrl: 'https://news.ycombinator.com/item?id=101',
      } as FeedItem['metadata'],
    });

    assert.equal(resolveSecondarySourceLink(item), null);
  });

  test('returns the HN discussion link from sourceId when metadata is missing', () => {
    const item = createArticleItem({
      source: 'hackernews',
      sourceId: 'hn-100001',
      url: 'https://news.example.com/research/synthetic-systems-paper',
      metadata: null,
    });

    assert.deepEqual(resolveSecondarySourceLink(item), {
      href: 'https://news.ycombinator.com/item?id=100001',
      label: 'HN Discussion',
    });
  });
});

describe('resolveHackerNewsPoints', () => {
  test('prefers fresh metrics likes over curate-time HN metadata score', () => {
    const item = createArticleItem({
      source: 'hackernews',
      metrics: { likes: 365, reposts: 0, replies: 12 },
      metadata: {
        hackerNews: {
          score: 101,
        },
      },
    });

    assert.equal(resolveHackerNewsPoints(item), 365);
  });

  test('falls back to metadata.hackerNews.score when metrics likes are empty', () => {
    const item = createArticleItem({
      source: 'hackernews',
      metrics: { likes: 0, reposts: 0, replies: 12 },
      metadata: {
        hackerNews: {
          score: 42,
        },
      },
    });

    assert.equal(resolveHackerNewsPoints(item), 42);
  });

  test('does not expose zero or non-HN scores as points', () => {
    assert.equal(resolveHackerNewsPoints(createArticleItem({
      source: 'hackernews',
      metrics: { likes: 0, reposts: 0, replies: 12 },
      metadata: {
        hackerNews: {
          score: 0,
        },
      },
    })), null);
    assert.equal(resolveHackerNewsPoints(createArticleItem({
      source: 'substack',
      metrics: { likes: 365, reposts: 0, replies: 12 },
      metadata: {
        hackerNews: {
          score: 365,
        },
      },
    })), null);
  });
});

describe('ArticleCard', () => {
  test('renders article body markdown when metadata opts in', () => {
    const item = createArticleItem({
      text: '## Decision\n\n**Move** embeddings to pgvector.',
      excerpt: null,
      metadata: { renderMarkdown: true },
    });

    const markup = renderToStaticMarkup(createElement(ArticleCard, {
      item,
      agentName: 'Agent',
      isLiked: false,
      isDisliked: false,
      votePending: false,
      onThumbsUp: () => {},
      onThumbsDown: () => {},
      expanded: false,
      onToggleExpand: () => {},
      showReasonInput: null,
      onReasonSubmit: () => {},
      onDismissReasonInput: () => {},
      detail: false,
    }));

    assert.match(markup, /<h2/);
    assert.match(markup, /<strong>Move<\/strong>/);
    assert.doesNotMatch(markup, /## Decision/);
  });

  test('renders analysis list-card body markdown instead of raw markdown characters', () => {
    const item = createAnalysisItem({
      title: 'Email digest',
      text: '## Priority\n\n**Sarah Kim** needs a reply.\n\n- Review the brief',
    });

    const markup = renderToStaticMarkup(createElement(ArticleCard, {
      item,
      agentName: 'Agent',
      isLiked: false,
      isDisliked: false,
      votePending: false,
      onThumbsUp: () => {},
      onThumbsDown: () => {},
      expanded: false,
      onToggleExpand: () => {},
      showReasonInput: null,
      onReasonSubmit: () => {},
      onDismissReasonInput: () => {},
      detail: false,
    }));

    assert.match(markup, /<h2/);
    assert.match(markup, /<strong>Sarah Kim<\/strong>/);
    assert.match(markup, /<li/);
    assert.doesNotMatch(markup, /## Priority/);
    assert.doesNotMatch(markup, /\*\*Sarah Kim\*\*/);
  });

  test('renders mcpAppHtml as the body without requiring agent-session layout', () => {
    const item = createArticleItem({
      source: 'openclaw',
      title: 'Freeform digest',
      text: 'Plain analysis fallback',
      reason: 'Curator included this because it needs review.',
      metadata: {
        mcpAppHtml: '<button data-evogent-action="x.follow">Follow</button>',
      },
    });

    const markup = renderToStaticMarkup(createElement(ArticleCard, {
      item,
      agentName: 'Agent',
      isLiked: false,
      isDisliked: false,
      votePending: false,
      onThumbsUp: () => {},
      onThumbsDown: () => {},
      expanded: false,
      onToggleExpand: () => {},
      showReasonInput: null,
      onReasonSubmit: () => {},
      onDismissReasonInput: () => {},
      detail: false,
    }));

    assert.match(markup, /data-testid="mcp-app-frame"/);
    assert.match(markup, /Freeform digest/);
    assert.match(markup, /data-testid="feed-card-context-reason"/);
    assert.match(markup, /Curator included this because it needs review\./);
    assert.match(markup, /x\.follow/);
    assert.match(markup, /Follow/);
    assert.doesNotMatch(markup, /Plain analysis fallback/);
  });

  test('renders curator bridge text on standalone connector article cards', () => {
    const item = createArticleItem({
      title: 'You should not update your dependencies in 2026',
      text: 'A brief history of software supply chain security.',
      reason: 'Blind updates invite supply-chain risk.',
      metadata: {
        bridge: 'Blind updates invite supply-chain risk.',
      } as FeedItem['metadata'],
    });

    const markup = renderToStaticMarkup(createElement(ArticleCard, {
      item,
      agentName: 'Agent',
      isLiked: false,
      isDisliked: false,
      votePending: false,
      onThumbsUp: () => {},
      onThumbsDown: () => {},
      expanded: false,
      onToggleExpand: () => {},
      showReasonInput: null,
      onReasonSubmit: () => {},
      onDismissReasonInput: () => {},
      detail: false,
    }));

    assert.match(markup, /data-testid="feed-card-context-reason"/);
    assert.match(markup, /Blind updates invite supply-chain risk\./);
  });

  test('renders curator bridge text on standalone YouTube article cards', () => {
    const item = createArticleItem({
      source: 'youtube',
      sourceId: 'a1B2c3D4e5F',
      url: 'https://www.youtube.com/watch?v=a1B2c3D4e5F',
      title: 'Example lecture on model training',
      text: 'Mid/post-training lecture description.',
      reason: 'Post-training shapes usable behavior.',
      metadata: {
        article: {
          videoId: 'a1B2c3D4e5F',
          canonicalUrl: 'https://www.youtube.com/watch?v=a1B2c3D4e5F',
          thumbnailUrl: 'https://img.youtube.com/vi/a1B2c3D4e5F/hqdefault.jpg',
          channelName: 'Example Learning',
          channelHandle: 'example_learning',
        },
      } as FeedItem['metadata'],
    });

    const markup = renderToStaticMarkup(createElement(ArticleCard, {
      item,
      agentName: 'Agent',
      isLiked: false,
      isDisliked: false,
      votePending: false,
      onThumbsUp: () => {},
      onThumbsDown: () => {},
      expanded: false,
      onToggleExpand: () => {},
      showReasonInput: null,
      onReasonSubmit: () => {},
      onDismissReasonInput: () => {},
      detail: false,
    }));

    assert.match(markup, /data-testid="feed-card-context-reason"/);
    assert.match(markup, /Post-training shapes usable behavior\./);
  });

  test('renders declared skill action buttons with payload data', () => {
    const item = createArticleItem({
      id: 'email-card-1',
      source: 'openclaw',
      title: 'Inbox needs triage',
      text: 'Three messages need replies.',
      metadata: {
        openClaw: {
          skill: 'email-triage',
        },
        senderDomain: 'example.com',
      } as FeedItem['metadata'],
    });

    const markup = renderToStaticMarkup(createElement(ArticleCard, {
      item,
      agentName: 'Agent',
      isLiked: false,
      isDisliked: false,
      votePending: false,
      onThumbsUp: () => {},
      onThumbsDown: () => {},
      expanded: false,
      onToggleExpand: () => {},
      showReasonInput: null,
      onReasonSubmit: () => {},
      onDismissReasonInput: () => {},
      skillSlug: 'email-triage',
      skillActions: [{
        id: 'skip-sender',
        label: 'Skip sender',
        confirms: 'Will skip future emails from this sender?',
        externalLink: false,
        requiresSelection: 'senderDomain',
      }],
      onSkillAction: () => {},
    }));

    assert.match(markup, /data-evogent-action="email-triage\.skip-sender"/);
    assert.match(markup, /Skip sender/);
    assert.match(markup, /senderDomain/);
    assert.match(markup, /example.com/);
  });

  test('no longer renders per-source open buttons (the card itself taps out)', () => {
    const item = createArticleItem({
      source: 'hackernews',
      sourceId: 'hn-100001',
      title: 'Synthetic systems paper',
      text: 'Synthetic systems paper',
      excerpt: 'Synthetic systems paper',
      url: 'https://news.ycombinator.com/item?id=100001',
      metadata: {
        canonicalUrl: 'https://news.example.com/research/synthetic-systems-paper',
      } as FeedItem['metadata'],
    });

    const markup = renderToStaticMarkup(createElement(ArticleCard, {
      item,
      agentName: 'Agent',
      isLiked: false,
      isDisliked: false,
      votePending: false,
      onThumbsUp: () => {},
      onThumbsDown: () => {},
      expanded: false,
      onToggleExpand: () => {},
      showReasonInput: null,
      onReasonSubmit: () => {},
      onDismissReasonInput: () => {},
    }));

    // The per-source "Open on …"/"Read original"/"HN Discussion" buttons were removed;
    // tapping the card now opens the item in its source app instead.
    assert.doesNotMatch(markup, />HN Discussion</);
    assert.doesNotMatch(markup, />Read original</);
  });

  test('does not render Read original for internal synthesis URLs', () => {
    const item = createArticleItem({
      source: 'openclaw',
      title: 'Which system can change course',
      text: 'Curator-authored analysis',
      url: 'internal://curation-analysis/which-system-can-change-course',
    });

    const markup = renderToStaticMarkup(createElement(ArticleCard, {
      item,
      agentName: 'Agent',
      isLiked: false,
      isDisliked: false,
      votePending: false,
      onThumbsUp: () => {},
      onThumbsDown: () => {},
      expanded: false,
      onToggleExpand: () => {},
      showReasonInput: null,
      onReasonSubmit: () => {},
      onDismissReasonInput: () => {},
    }));

    assert.doesNotMatch(markup, />Read original</);
    assert.doesNotMatch(markup, /internal:\/\/curation-analysis/);
  });

  test('does not render Read original for non-web placeholder URLs', () => {
    for (const url of [
      'openclaw://curation/agents-memory-and-checks',
      'evogent://reflection/6dcb6cf4-cc65-4cd8-a8a1-5bcd63df0e7f',
    ]) {
      const item = createArticleItem({
        source: 'openclaw',
        title: 'Internal card',
        text: 'Curator-authored card',
        url,
      });

      const markup = renderToStaticMarkup(createElement(ArticleCard, {
        item,
        agentName: 'Agent',
        isLiked: false,
        isDisliked: false,
        votePending: false,
        onThumbsUp: () => {},
        onThumbsDown: () => {},
        expanded: false,
        onToggleExpand: () => {},
        showReasonInput: null,
        onReasonSubmit: () => {},
        onDismissReasonInput: () => {},
      }));

      assert.doesNotMatch(markup, />Read original</);
      assert.doesNotMatch(markup, new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  });

  test('renders HN points as a separate action-row signal', () => {
    const item = createArticleItem({
      source: 'hackernews',
      sourceId: 'hn-100001',
      title: 'Synthetic systems paper',
      text: 'Synthetic systems paper',
      excerpt: 'Synthetic systems paper',
      url: 'https://news.example.com/research/synthetic-systems-paper',
      metrics: { likes: 365, reposts: 0, replies: 12 },
      metadata: {
        hackerNews: {
          score: 101,
        },
      },
    });

    const markup = renderToStaticMarkup(createElement(ArticleCard, {
      item,
      agentName: 'Agent',
      isLiked: false,
      isDisliked: false,
      votePending: false,
      onThumbsUp: () => {},
      onThumbsDown: () => {},
      expanded: false,
      onToggleExpand: () => {},
      showReasonInput: null,
      onReasonSubmit: () => {},
      onDismissReasonInput: () => {},
    }));

    assert.match(markup, /data-testid="hacker-news-points"/);
    assert.match(markup, />HN</);
    assert.match(markup, />365 pts</);
  });

  test('renders list prominence with larger responsive headline typography', () => {
    const item = createArticleItem({
      metadata: {
        prominence: {
          level: 'lead',
          source: 'homepage',
          evidence: 'Large headline in the top homepage slot.',
        },
      },
    });

    const markup = renderToStaticMarkup(createElement(ArticleCard, {
      item,
      agentName: 'Agent',
      isLiked: false,
      isDisliked: false,
      votePending: false,
      onThumbsUp: () => {},
      onThumbsDown: () => {},
      expanded: false,
      onToggleExpand: () => {},
      showReasonInput: null,
      onReasonSubmit: () => {},
      onDismissReasonInput: () => {},
      detail: false,
    }));

    assert.match(markup, /text-\[21px\] leading-tight sm:text-\[24px\]/);
    assert.match(markup, /text-\[15px\] leading-7/);
  });

  test('keeps child card typography normal for thread-only homepage prominence', () => {
    const item = createArticleItem({
      metadata: {
        cycleId: 'cycle-1',
        thread: {
          threadId: 'thread-1',
          threadTitle: 'Major homepage event',
          prominence: {
            level: 'lead',
            source: 'homepage',
            evidence: 'Large headline in the top homepage slot.',
          },
        },
      },
    });

    const markup = renderToStaticMarkup(createElement(ArticleCard, {
      item,
      agentName: 'Agent',
      isLiked: false,
      isDisliked: false,
      votePending: false,
      onThumbsUp: () => {},
      onThumbsDown: () => {},
      expanded: false,
      onToggleExpand: () => {},
      showReasonInput: null,
      onReasonSubmit: () => {},
      onDismissReasonInput: () => {},
      detail: false,
    }));

    assert.match(markup, /text-\[17px\] leading-snug/);
    assert.match(markup, /text-\[14px\] leading-relaxed/);
    assert.doesNotMatch(markup, /text-\[21px\] leading-tight sm:text-\[24px\]/);
  });

  test('renders detail prominence with larger responsive headline typography', () => {
    const item = createArticleItem({
      metadata: {
        prominence: {
          level: 'prominent',
        },
      },
    });

    const markup = renderToStaticMarkup(createElement(ArticleCard, {
      item,
      agentName: 'Agent',
      isLiked: false,
      isDisliked: false,
      votePending: false,
      onThumbsUp: () => {},
      onThumbsDown: () => {},
      expanded: false,
      onToggleExpand: () => {},
      showReasonInput: null,
      onReasonSubmit: () => {},
      onDismissReasonInput: () => {},
    }));

    assert.match(markup, /text-\[34px\] leading-\[1\.08\] sm:text-5xl/);
    assert.match(markup, /text-\[18px\] leading-8 sm:text-\[20px\]/);
  });
});

describe('resolveOgDescriptionSubtitle', () => {
  test('uses ogDescription as a subtitle when the main text is short', () => {
    assert.equal(
      resolveOgDescriptionSubtitle(
        { ogDescription: 'A solid reading list for distributed systems.' } as FeedItem['metadata'],
        'Ask HN: Best distributed systems papers?',
      ),
      'A solid reading list for distributed systems.',
    );
  });

  test('skips the subtitle when the main text is already long', () => {
    assert.equal(
      resolveOgDescriptionSubtitle(
        { ogDescription: 'A solid reading list for distributed systems.' } as FeedItem['metadata'],
        'A'.repeat(100),
      ),
      null,
    );
  });
});

describe('resolveYouTubeViewLabel', () => {
  test('prefers the human-readable YouTube view count text', () => {
    assert.equal(
      resolveYouTubeViewLabel({ viewCount: 1700, viewCountText: '1.7K views' }),
      '1.7K views',
    );
  });

  test('falls back to formatting the numeric view count when text is missing', () => {
    assert.equal(
      resolveYouTubeViewLabel({ viewCount: 1700, viewCountText: null }),
      '1.7K views',
    );
  });
});
