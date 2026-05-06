import assert from 'node:assert';
import { afterEach, describe, test } from 'node:test';
import {
  buildBatchEnrichmentPrompt,
  buildEnrichmentPrompt,
  resolveFeedItemTweetId,
} from './feed-enrichment-prompt';
import type { FeedItem } from '@/types/feed';

const originalOrchestratorInternalUrl = process.env.ORCHESTRATOR_INTERNAL_URL;
const originalEvogentInternalBaseUrl = process.env.MEDIA_AGENT_INTERNAL_BASE_URL;

afterEach(() => {
  if (originalOrchestratorInternalUrl === undefined) {
    delete process.env.ORCHESTRATOR_INTERNAL_URL;
  } else {
    process.env.ORCHESTRATOR_INTERNAL_URL = originalOrchestratorInternalUrl;
  }

  if (originalEvogentInternalBaseUrl === undefined) {
    delete process.env.MEDIA_AGENT_INTERNAL_BASE_URL;
  } else {
    process.env.MEDIA_AGENT_INTERNAL_BASE_URL = originalEvogentInternalBaseUrl;
  }
});

function buildFeedItem(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    id: 'feed-item-1',
    type: 'tweet',
    source: 'twitter',
    sourceId: 'tweet-987654321',
    parentId: null,
    relationship: 'parent',
    title: null,
    text: 'Parent tweet text',
    url: 'https://x.com/example/status/987654321',
    excerpt: null,
    authorUsername: 'example',
    authorDisplayName: 'Example',
    reason: null,
    tags: [],
    mediaUrls: [],
    metrics: {
      likes: 12,
      reposts: 3,
      replies: 4,
    },
    authorAvatarUrl: null,
    isLiked: false,
    isDisliked: false,
    metadata: {
      quotedTweet: {
        text: 'Quoted tweet text',
        author: {
          username: 'quoted',
        },
      },
    },
    publishedAt: '2026-03-14T10:00:00.000Z',
    createdAt: '2026-03-14T10:00:00.000Z',
    ...overrides,
  };
}

function buildHackerNewsItem(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    ...buildFeedItem(),
    id: 'feed-item-hn-1',
    type: 'article',
    source: 'hackernews',
    sourceId: 'hn-123',
    relationship: null,
    title: 'Ask HN: Example',
    text: 'Original HN story summary',
    url: 'https://example.com/story',
    authorUsername: 'hn-user',
    authorDisplayName: 'HN User',
    metadata: {
      hnUrl: 'https://news.ycombinator.com/item?id=123',
    },
    ...overrides,
  };
}

describe('feed enrichment prompt', () => {
  test('resolveFeedItemTweetId prefers normalized source IDs', () => {
    assert.strictEqual(resolveFeedItemTweetId(buildFeedItem()), '987654321');
  });

  test('tweet enrichment points the agent at the main tweet page instead of Bird CLI', () => {
    const prompt = buildEnrichmentPrompt(buildFeedItem(), '/tmp/feed-output.jsonl', {
      mode: 'full',
      tweetId: '987654321',
    });

    assert.doesNotMatch(prompt, /Bird CLI setup/);
    assert.doesNotMatch(prompt, /\$BIRD replies/);
    assert.match(prompt, /Do not call Bird CLI or any Twitter\/X scraping tool yourself/);
    assert.match(prompt, /open the MAIN tweet URL in the browser and capture that visible upstream thread context/);
    assert.match(prompt, /Check already-persisted feed context first with curl/);
    assert.match(prompt, /Existing parent\/thread\/reply items for this post: http:\/\/127\.0\.0\.1:3001\/api\/feed\/feed-item-1\/children/);
    assert.match(prompt, /make it self-contained: fetch the visible upstream thread context from the MAIN tweet page/);
    assert.match(prompt, /Persist the direct parent tweet as relationship="parent"/);
  });

  test('tweet enrichment honors the resolved internal base URL', () => {
    delete process.env.MEDIA_AGENT_INTERNAL_BASE_URL;
    process.env.ORCHESTRATOR_INTERNAL_URL = 'http://127.0.0.1:3115';

    const prompt = buildEnrichmentPrompt(buildFeedItem(), '/tmp/feed-output.jsonl', {
      mode: 'full',
      tweetId: '987654321',
    });

    assert.match(prompt, /Resolved internal API base: http:\/\/127\.0\.0\.1:3115/);
    assert.match(prompt, /http:\/\/127\.0\.0\.1:3115\/api\/internal\/curate\/submit/);
    assert.match(prompt, /http:\/\/127\.0\.0\.1:3115\/api\/feed\/feed-item-1\/children/);
  });

  test('lightweight mode only captures tweet-page context and avoids feed-flooding work', () => {
    const prompt = buildEnrichmentPrompt(buildFeedItem(), '/tmp/feed-output.jsonl', {
      mode: 'lightweight',
      tweetId: '987654321',
    });

    assert.match(prompt, /lightweight tweet intake enrichment sub-agent/);
    assert.strictEqual(prompt.match(/EVOGENT-DATA-OPEN\/CLOSE/g)?.length, 1);
    assert.match(prompt, /EVOGENT-DATA-OPEN:[0-9a-f]{32}/);
    assert.match(prompt, /kind: tweet/);
    assert.match(prompt, /Parent tweet text/);
    assert.match(prompt, /Quoted tweet text/);
    assert.match(prompt, /EVOGENT-DATA-CLOSE:[0-9a-f]{32}/);
    const markerNonces = [...prompt.matchAll(/EVOGENT-DATA-(?:OPEN|CLOSE):([0-9a-f]{32})/g)].map((match) => match[1] ?? '');
    assert.ok(markerNonces.length >= 4);
    assert.strictEqual(new Set(markerNonces).size, 1);
    assert.match(prompt, /GET the current parent post first, then PATCH verified missing fields/);
    assert.match(prompt, /source-vs-current-feed diff/);
    assert.match(prompt, /Visit the MAIN tweet URL in the browser/);
    assert.match(prompt, /Create verified parent\/thread tweet items here only when needed/);
    assert.match(prompt, /Treat named fields as examples, not a closed list/);
    assert.match(prompt, /communityNote metadata/);
    assert.match(prompt, /metadata\.communityNote:\{text,sourceUrl\}/);
    assert.match(prompt, /metadata\.quotedTweet\.communityNote/);
    assert.match(prompt, /External article\/link cards are supported missing facts/);
    assert.match(prompt, /metadata\.media alt text/);
    assert.match(prompt, /metadata\.poll/);
    assert.match(prompt, /X polls are supported missing facts/);
    assert.match(prompt, /Preserve card imageAlt/);
    assert.match(prompt, /metadata\.communityNote or metadata\.quotedTweet\.communityNote/);
    assert.match(prompt, /"linkCard":\{"type":"article","url":"https:\/\/github\.com\/openclaw\/clawsweeper"/);
    assert.match(prompt, /"imageAlt":"Repository preview image"/);
    assert.match(prompt, /"poll":\{"options":\[\{"label":"Yes","voteCount":60\}/);
    assert.match(prompt, /"communityNote":\{"text":"Readers added context note text","sourceUrl":"https:\/\/example\.com\/note-source"\}/);
    assert.match(prompt, /verify the PATCH response or GET the current parent post again/);
    assert.match(prompt, /poster attribute \(videos\)/);
    assert.match(prompt, /PATCH the parent post metrics with the live likes, reposts, replies, and views counts/);
    assert.match(prompt, /skip the metrics write instead of sending guessed zeros/);
    assert.match(prompt, /On Hacker News pages, if the visible points or comment counters are readable and differ from the stored item, PATCH those metrics onto the existing post too/);
    assert.match(prompt, /"media_urls":\["https:\/\/pbs\.twimg\.com\/amplify_video_thumb\/example\.jpg"\]/);
    assert.match(prompt, /"metrics_likes":107,"metrics_reposts":10,"metrics_replies":25,"metrics_views":8122/);
    assert.match(prompt, /Read data\/curation-prompt\.md and apply the same editorial bar you use during curation when deciding whether a reply or comment is worth persisting/);
    assert.match(prompt, /relationship="reply"/);
    assert.match(prompt, /Hacker News or includes an HN discussion URL in metadata/);
    assert.match(prompt, /site:reddit\.com/);
    assert.match(prompt, /metadata\.suggestionType="code_fix"/);
    assert.match(prompt, /at most ONE code_fix suggestion/);
    assert.doesNotMatch(prompt, /poll results, community note, Spaces/);
    assert.doesNotMatch(prompt, /article card preview/);
    assert.match(prompt, /Do not search for articles/);
    assert.match(prompt, /Do not generate an analysis item/);
    assert.doesNotMatch(prompt, /Step 2: Web context/);
    assert.doesNotMatch(prompt, /Write exactly one analysis item/);
    assert.doesNotMatch(prompt, /Find 2-3 related high-signal web articles/);
  });

  test('full tweet enrichment references the shared curation prompt for reply selection', () => {
    const prompt = buildEnrichmentPrompt(buildFeedItem(), '/tmp/feed-output.jsonl', {
      mode: 'full',
      tweetId: '987654321',
    });

    assert.match(prompt, /Read data\/curation-prompt\.md and apply the same editorial bar you use during curation/);
    assert.match(prompt, /Scroll the MAIN tweet reply section/);
    assert.match(prompt, /adds real value/);
    assert.match(prompt, /relationship="reply"/);
  });

  test('full article enrichment treats HN comment trees as reply candidates', () => {
    const prompt = buildEnrichmentPrompt(buildHackerNewsItem(), '/tmp/feed-output.jsonl', {
      mode: 'full',
    });

    assert.match(prompt, /kind: hn-comment/);
    assert.match(prompt, /Original HN story summary/);
    assert.match(prompt, /If the parent post is from Hacker News or includes an HN discussion URL in metadata/);
    assert.match(prompt, /scroll the comment tree/);
    assert.match(prompt, /relationship="reply"/);
    assert.match(prompt, /site:news\.ycombinator\.com/);
  });

  test('lightweight article enrichment fetches the canonical article URL', () => {
    const prompt = buildEnrichmentPrompt(buildHackerNewsItem({
      source: 'web',
      sourceId: 'https://example.com/article',
      url: 'https://example.com/article',
      metadata: null,
    }), '/tmp/feed-output.jsonl', {
      mode: 'lightweight',
    });

    assert.match(prompt, /lightweight article intake enrichment sub-agent/);
    assert.match(prompt, /Article URL: https:\/\/example\.com\/article/);
    assert.match(prompt, /Open the article URL with whatever fetch tool fits/);
    assert.match(prompt, /Reading the item's canonical article URL is allowed; it is not generic web search/);
    assert.match(prompt, /PATCH the feed row text with the synopsis and media_urls with \[hero_image_url\]/);
    assert.match(prompt, /metadata\.articleEnrichment/);
    assert.match(prompt, /skipReason/);
    assert.doesNotMatch(prompt, /Visit the MAIN tweet URL in the browser/);
    assert.match(prompt, /Fetch only the current item's own article URL/);
  });

  test('batch enrichment prompt is trimmed and enforces immediate per-item patching', () => {
    delete process.env.MEDIA_AGENT_INTERNAL_BASE_URL;
    process.env.ORCHESTRATOR_INTERNAL_URL = 'http://127.0.0.1:3115';

    const prompt = buildBatchEnrichmentPrompt([
      buildFeedItem(),
      buildHackerNewsItem(),
    ], { requestId: 'batch-test-1' });

    assert.match(prompt, /batch post enrichment sub-agent/i);
    assert.strictEqual(prompt.match(/The sections below labelled with EVOGENT-DATA-OPEN\/CLOSE markers/g)?.length, 1);
    assert.match(prompt, /Items:\n<<<EVOGENT-DATA-OPEN:[0-9a-f]{32}>>>\nkind: feed-batch-items\n\[/);
    assert.match(prompt, /<<<EVOGENT-DATA-CLOSE:[0-9a-f]{32}>>>/);
    const markerNonces = [...prompt.matchAll(/EVOGENT-DATA-(?:OPEN|CLOSE):([0-9a-f]{32})/g)].map((match) => match[1] ?? '');
    assert.strictEqual(markerNonces.length, 2);
    assert.strictEqual(new Set(markerNonces).size, 1);
    assert.match(prompt, /Batch request ID: batch-test-1/);
    assert.match(prompt, /Process the listed items strictly in order/);
    assert.match(prompt, /Do NOT read `CLAUDE\.md`, `\.claude\/CLAUDE\.md`, or any other repo instructions before starting/);
    assert.match(prompt, /GET and PATCH each current item at: http:\/\/127\.0\.0\.1:3115\/api\/feed\/<feedId>/);
    assert.match(prompt, /First GET the current feed item, then open the source URL/);
    assert.match(prompt, /PATCH metadata\.batchEnrichment\.status="running"/);
    assert.match(prompt, /metadata\.batchEnrichment\.requestId="batch-test-1"/);
    assert.match(prompt, /source-vs-current-feed diff/);
    assert.match(prompt, /Treat named fields as examples, not a closed list/);
    assert.match(prompt, /communityNote metadata/);
    assert.match(prompt, /metadata\.communityNote:\{text,sourceUrl\}/);
    assert.match(prompt, /metadata\.quotedTweet\.communityNote/);
    assert.match(prompt, /PATCH every supported missing factual field immediately before you open the next item/);
    assert.match(prompt, /verify the PATCH response or GET the item again/);
    assert.match(prompt, /Do not buffer PATCH calls until the end of the batch/);
    assert.match(prompt, /Never run a cross-item extractor or collect metrics for multiple items before writing/);
    assert.match(prompt, /GET current -> navigate -> compare -> PATCH -> verify/);
    assert.match(prompt, /Do NOT use python, python3, requests, bs4, curl GET, or any raw HTTP fetch to read x\.com or news\.ycombinator\.com item pages/);
    assert.match(prompt, /use only `mcp__playwright__browser_navigate` and `mcp__playwright__browser_snapshot`/);
    assert.match(prompt, /If a snapshot appears to show a different tweet, Hacker News story, or page than the current item URL/);
    assert.match(prompt, /Retry the same URL up to 3 times, then skip that item's metrics write/);
    assert.match(prompt, /avatar, display name\/handle, text if stored text is truncated/);
    assert.match(prompt, /snapshot-visible URLs only/);
    assert.match(prompt, /"media_urls":\["https:\/\/pbs\.twimg\.com\/amplify_video_thumb\/example\.jpg"\]/);
    assert.match(prompt, /"communityNote":\{"text":"Readers added context note text","sourceUrl":"https:\/\/example\.com\/note-source"\}/);
    assert.match(prompt, /Do NOT send nested metrics objects/);
    assert.match(prompt, /relationship="reply" and parentId set to the current item feedId/);
    assert.match(prompt, /terminal reply\/comment audit receipt/);
    assert.match(prompt, /Completion is not just metrics\/avatar\/media/);
    assert.match(prompt, /status:"completed"/);
    assert.match(prompt, /replyAudit:\{batchRequestId:"batch-test-1"/);
    assert.match(prompt, /noMeaningfulRepliesReason/);
    assert.match(prompt, /status="failed"/);
    assert.match(prompt, /https:\/\/x\.com\/example\/status\/987654321/);
    assert.match(prompt, /https:\/\/news\.ycombinator\.com\/item\?id=123/);
    assert.doesNotMatch(prompt, /Step 2: Web context/);
    assert.doesNotMatch(prompt, /Write exactly one analysis item/);
    assert.doesNotMatch(prompt, /Read data\/curation-prompt\.md/);
  });

  test('tweet enrichment prompts require URL-matched main tweet identification', () => {
    const batchPrompt = buildBatchEnrichmentPrompt([buildFeedItem()], { requestId: 'batch-main-match' });
    const fullPrompt = buildEnrichmentPrompt(buildFeedItem(), '/tmp/feed-output.jsonl', {
      mode: 'full',
      tweetId: '987654321',
    });
    const lightweightPrompt = buildEnrichmentPrompt(buildFeedItem(), '/tmp/feed-output.jsonl', {
      mode: 'lightweight',
      tweetId: '987654321',
    });

    for (const prompt of [batchPrompt, fullPrompt, lightweightPrompt]) {
      assert.match(prompt, /MAIN-TWEET IDENTIFICATION/);
      assert.match(prompt, /articles\[0\] is often the parent tweet, not the main tweet/);
      assert.match(prompt, /Never use array index alone to identify the main article/);
      assert.match(prompt, /a\[href\] ending with \/status\/<sourceId>/);
      assert.match(prompt, /relationship="parent"/);
      assert.match(prompt, /relationship="thread", oldest first/);
      assert.match(prompt, /articles after the matched main index/);
      assert.match(prompt, /PATCH text, media_urls, metrics, and linkCard/);
      assert.match(prompt, /different topics, different framings, or different tweet authors/);
      assert.match(prompt, /Use agent judgment, not a JS text comparator/);
      assert.match(prompt, /Do not PATCH text merely because a candidate is longer/);
      assert.doesNotMatch(prompt, /full\.length\s*>\s*current\.text\.length\s*\+\s*20/);
    }
  });

  test('batch enrichment resolves HN discussion URLs from sourceId when metadata omits hnUrl', () => {
    const prompt = buildBatchEnrichmentPrompt([
      buildHackerNewsItem({
        sourceId: 'hn-47897953',
        url: 'https://devin.ai/terminal',
        metadata: null,
      }),
    ]);

    assert.match(prompt, /https:\/\/news\.ycombinator\.com\/item\?id=47897953/);
    assert.doesNotMatch(prompt, /https:\/\/devin\.ai\/terminal/);
  });

  test('batch prompt covers the 09:04 avatar drop by requiring author_avatar_url before the next item', () => {
    const prompt = buildBatchEnrichmentPrompt([
      buildFeedItem({
        id: '6055f471-6dc0-4a6b-b417-7cb8f32286eb',
        url: 'https://x.com/paulg/status/2047944827887591681',
        authorAvatarUrl: null,
      }),
    ]);

    assert.match(prompt, /authorAvatarUrl:null/);
    assert.match(prompt, /payload\.authorAvatarUrl/);
    assert.match(prompt, /include author_avatar_url in that PATCH/);
    assert.match(prompt, /Do not move to the next item until supported visible fields you patched, such as authorAvatarUrl, are no longer blank/);
  });

  test('batch prompt routes unsupported visible source features to one code_fix suggestion with evidence', () => {
    const prompt = buildBatchEnrichmentPrompt([
      buildFeedItem(),
      buildFeedItem({ id: 'feed-item-2', url: 'https://x.com/example/status/222' }),
    ]);

    assert.match(prompt, /submit at most ONE code_fix suggestion for the entire batch/);
    assert.match(prompt, /Spaces, long-form card/);
    assert.doesNotMatch(prompt, /poll results, Spaces, long-form card, alt text/);
    assert.doesNotMatch(prompt, /poll results, community note, Spaces/);
    assert.doesNotMatch(prompt, /article card preview/);
    assert.match(prompt, /POST \/api\/internal\/curate\/submit/);
    assert.match(prompt, /type="suggestion" and metadata\.suggestionType="code_fix"/);
    assert.match(prompt, /concrete feedId\(s\), source URL\(s\), what was visibly present, what persistence\/rendering path was missing or rejected, and acceptance criteria/);
    assert.match(prompt, /Ordinary extraction misses must be PATCHed immediately, not suggested/);
  });

  test('batch prompt treats article and link cards as supported missing facts', () => {
    const prompt = buildBatchEnrichmentPrompt([
      buildFeedItem(),
    ]);

    assert.match(prompt, /External article\/link cards are supported missing facts/);
    assert.match(prompt, /X Readers added context \/ community notes are supported missing facts/);
    assert.match(prompt, /X polls are supported missing facts/);
    assert.match(prompt, /metadata\.linkCard/);
    assert.match(prompt, /metadata\.linkPreviews/);
    assert.match(prompt, /metadata\.urlEntities/);
    assert.match(prompt, /metadata\.poll/);
    assert.match(prompt, /"linkCard":\{"type":"article","url":"https:\/\/github\.com\/openclaw\/clawsweeper"/);
    assert.match(prompt, /"imageAlt":"Repository preview image"/);
    assert.match(prompt, /"urlEntities":\[\{"url":"https:\/\/t\.co\/example","expandedUrl":"https:\/\/github\.com\/openclaw\/clawsweeper"/);
  });

  test('batch prompt includes YouTube watch-page metrics and comment guidance', () => {
    const prompt = buildBatchEnrichmentPrompt([
      buildFeedItem(),
    ]);

    for (const expected of [
      'YouTube guidance:',
      'ytInitialPlayerResponse',
      'like-button-view-model',
      'ytd-comment-thread-renderer',
      'metrics_views',
      'metrics_likes',
      'metrics_replies',
    ]) {
      assert.match(prompt, new RegExp(expected));
    }
  });

  test('batch prompt keeps source judgement without credential or brittle test-id automation', () => {
    const prompt = buildBatchEnrichmentPrompt([
      buildFeedItem(),
    ], { requestId: 'batch-test-heuristics' });

    assert.match(prompt, /Read the tweet page directly/);
    assert.match(prompt, /Only keep replies that meaningfully extend the parent/);
    assert.doesNotMatch(prompt, /document\.cookie/);
    assert.doesNotMatch(prompt, /cookie injection/i);
    assert.doesNotMatch(prompt, /data-testid/);
  });

  test('full tweet enrichment falls back to a stable status URL when the stored URL is missing', () => {
    const prompt = buildEnrichmentPrompt(buildFeedItem({
      url: null,
    }), '/tmp/feed-output.jsonl', {
      mode: 'full',
      tweetId: '987654321',
    });

    assert.match(prompt, /MAIN tweet URL for reply fetches: https:\/\/x\.com\/example\/status\/987654321/);
  });
});
