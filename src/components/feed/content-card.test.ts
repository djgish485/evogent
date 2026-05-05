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
  getTweetLinkPreviews,
  resolveHackerNewsPoints,
  resolveOgDescriptionSubtitle,
  resolveContentCardOuterClass,
  resolveSecondarySourceLink,
  resolveSourceDisplayLabel,
  resolveSourceOpenLabel,
  resolveYouTubeViewLabel,
  shouldRenderContentCardChildPreviews,
  shouldRenderContentCardParentTweetPreview,
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
    url: 'https://importai.substack.com/p/example',
    excerpt: 'Article excerpt',
    authorUsername: 'importai',
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
    sourceId: '2047982647264059734',
    parentId: null,
    relationship: null,
    title: null,
    text: 'Built clawsweeper in a browser tab.',
    url: 'https://x.com/steipete/status/2047982647264059734',
    excerpt: null,
    authorUsername: 'steipete',
    authorDisplayName: 'Peter Steinberger',
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

describe('resolveSourceOpenLabel', () => {
  test('maps supported sources to source-aware open labels', () => {
    assert.equal(resolveSourceOpenLabel('twitter'), 'Open on X');
    assert.equal(resolveSourceOpenLabel('hackernews'), 'Open on HN');
    assert.equal(resolveSourceOpenLabel('youtube'), 'Open on YouTube');
    assert.equal(resolveSourceOpenLabel('substack'), 'Open on Substack');
    assert.equal(resolveSourceOpenLabel('rss'), 'Open link');
  });
});

describe('getTweetLinkPreviews', () => {
  test('renders an exact-cache linkCard through the tweet link preview path', () => {
    const item = createTweetItem({
      metadata: {
        linkCard: {
          type: 'article',
          url: 'https://github.com/openclaw/clawsweeper',
          title: 'GitHub - openclaw/clawsweeper',
          domain: 'github.com',
          imageUrl: 'https://opengraph.githubassets.com/example/openclaw/clawsweeper',
          imageAlt: 'Repository preview image',
          description: 'Minesweeper built with Claw.',
        },
      },
    });

    assert.deepEqual(getTweetLinkPreviews(item), [{
      url: 'https://github.com/openclaw/clawsweeper',
      title: 'GitHub - openclaw/clawsweeper',
      domain: 'github.com',
      image: 'https://opengraph.githubassets.com/example/openclaw/clawsweeper',
      imageAlt: 'Repository preview image',
      description: 'Minesweeper built with Claw.',
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
          username: 'polymarket',
          displayName: 'Polymarket',
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
          username: 'polymarket',
          displayName: 'Polymarket',
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
      mediaUrls: ['https://pbs.twimg.com/media/siemens.jpg'],
      metadata: {
        media: [{
          type: 'image',
          url: 'https://pbs.twimg.com/media/siemens.jpg',
          alt: 'Siemens SGT5-8000H gas turbine in assembly',
        }],
        linkCard: {
          type: 'article',
          url: 'https://www.bbc.com/news/example',
          title: 'BBC example',
          domain: 'bbc.com',
          imageUrl: 'https://ichef.bbci.co.uk/news/example.jpg',
          imageAlt: 'BBC card image description',
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

    assert.match(markup, /alt="Siemens SGT5-8000H gas turbine in assembly"/);
    assert.match(markup, /alt="BBC card image description"/);
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
          username: 'polymarket',
          displayName: 'Polymarket',
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
      sourceId: 'hn-47897953',
      url: 'https://devin.ai/terminal',
      metadata: null,
    });

    assert.deepEqual(resolveSecondarySourceLink(item), {
      href: 'https://news.ycombinator.com/item?id=47897953',
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
  test('renders Hacker News discussion and original article actions separately', () => {
    const item = createArticleItem({
      source: 'hackernews',
      sourceId: 'hn-47897953',
      title: 'Devin for Terminal',
      text: 'Devin for Terminal',
      excerpt: 'Devin for Terminal',
      url: 'https://devin.ai/terminal',
      metadata: null,
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

    assert.match(markup, /href="https:\/\/news\.ycombinator\.com\/item\?id=47897953"/);
    assert.match(markup, />HN Discussion</);
    assert.match(markup, /href="https:\/\/devin\.ai\/terminal"/);
    assert.match(markup, />Read original</);
  });

  test('renders HN points as a separate action-row signal', () => {
    const item = createArticleItem({
      source: 'hackernews',
      sourceId: 'hn-47897953',
      title: 'Devin for Terminal',
      text: 'Devin for Terminal',
      excerpt: 'Devin for Terminal',
      url: 'https://devin.ai/terminal',
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
    assert.match(markup, /text-\[16px\] leading-7/);
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
    assert.match(markup, /text-\[15px\] leading-relaxed/);
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
