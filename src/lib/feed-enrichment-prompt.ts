import path from 'node:path';
import { getDataPath } from '@/lib/data-dir';
import {
  buildTweetStatusUrl,
  normalizeTweetSourceId,
} from '@/lib/db/feed';
import { getInternalBaseUrl } from '@/lib/internal-api';
import { resolveHackerNewsDiscussionUrl } from '@/lib/hacker-news';
import type { FeedItem } from '@/types/feed';
import {
  UNTRUSTED_CONTENT_PROMPT_PRELUDE,
  createPromptSafetyNonce,
  wrapUntrustedContent,
} from '../../lib/prompt-safety.js';

export type EnrichmentPromptMode = 'lightweight' | 'full';

function resolveUntrustedFeedKind(post: FeedItem): string {
  if (post.type === 'tweet') return 'tweet';
  if (post.source === 'hackernews') return 'hn-comment';
  if (post.type === 'article') return 'article';
  return 'feed-item';
}

function buildPromptPostPayload(post: FeedItem, nonce: string): string {
  if (!post.metadata?.quotedTweet) {
    return wrapUntrustedContent(JSON.stringify(post, null, 2), resolveUntrustedFeedKind(post), nonce);
  }

  const restMetadata = { ...post.metadata };
  delete restMetadata.quotedTweet;
  const sanitizedPost: FeedItem = {
    ...post,
    metadata: Object.keys(restMetadata).length > 0 ? restMetadata : null,
  };

  return wrapUntrustedContent(JSON.stringify(sanitizedPost, null, 2), resolveUntrustedFeedKind(post), nonce);
}

function buildQuotedTweetContext(post: FeedItem, nonce: string): string[] {
  const quote = post.metadata?.quotedTweet;
  if (!quote) {
    return [];
  }

  return [
    'Quoted tweet context (read-only; NOT a parent, NOT a reply target, do NOT use its ID or URL anywhere):',
    wrapUntrustedContent(JSON.stringify({
      authorUsername: quote.author.username,
      text: quote.text || '[no quoted tweet text available]',
    }, null, 2), 'tweet', nonce),
    '- URL and numeric tweet ID intentionally omitted so you do not follow the wrong thread.',
    '',
  ];
}

function resolveTweetIdentifier(value: string | null | undefined) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;

  const prefixedMatch = trimmed.match(/^tweet-(\d+)$/i);
  if (prefixedMatch?.[1]) {
    return prefixedMatch[1];
  }

  const statusMatch = trimmed.match(/\/status\/(\d+)/);
  if (statusMatch?.[1]) {
    return statusMatch[1];
  }

  const normalized = normalizeTweetSourceId(trimmed);
  return /^\d+$/.test(normalized) ? normalized : null;
}

export function resolveFeedItemTweetId(post: FeedItem) {
  return resolveTweetIdentifier(post.sourceId) ?? resolveTweetIdentifier(post.url);
}

function resolveMainTweetUrl(post: FeedItem, tweetId: string | null): string {
  const directUrl = post.url?.trim();
  if (directUrl) {
    return directUrl;
  }

  const authorUrl = buildTweetStatusUrl(post.authorUsername, post.sourceId);
  if (authorUrl) {
    return authorUrl;
  }

  if (tweetId) {
    return `https://x.com/i/web/status/${tweetId}`;
  }

  return 'UNAVAILABLE';
}

function resolveBatchItemUrl(post: FeedItem): string {
  if (post.source === 'hackernews') {
    return resolveHackerNewsDiscussionUrl(post) ?? post.url?.trim() ?? 'UNAVAILABLE';
  }

  if (post.type === 'tweet') {
    return resolveMainTweetUrl(post, resolveFeedItemTweetId(post));
  }

  return post.url?.trim() ?? 'UNAVAILABLE';
}

const mainTweetIdentificationInstructions = [
  'MAIN-TWEET IDENTIFICATION:',
  '1. On x.com/<user>/status/<sourceId> pages, articles[0] is often the parent tweet, not the main tweet. Never use array index alone to identify the main article.',
  '2. Identify the main article as the article whose self-link href matches the current page URL: it contains an a[href] ending with /status/<sourceId> for the current item sourceId. Equivalent: the only article whose own permalink anchor points to its own /status/<id>.',
  '3. Articles before the matched main article are upstream context. Persist the article immediately preceding main as relationship="parent"; persist older ancestors as relationship="thread", oldest first. Articles after the matched main article are reply candidates, so any reply picker must use articles after the matched main index.',
  '4. PATCH text, media_urls, metrics, and linkCard for the main feed row only from the matched main article, never from articles[0] blindly.',
  '5. Before PATCHing media_urls, identify whether the rendered tweet contains a quote tweet: an embedded tweet preview with its own author, handle, timestamp, or border inside the parent article. If yes, ALL quote-tweet content belongs to metadata.quotedTweet, not to the parent media_urls.',
  '6. When the embedded quote tweet contains an article link card, such as a Substack, news, or blog preview with visible domain, title, or hero image, populate metadata.quotedTweet.linkCard:{type, url, title, domain, imageUrl, imageAlt, description}. The hero image of that card belongs in metadata.quotedTweet.linkCard.imageUrl, not parent media_urls.',
  '7. Quote tweets where the body is primarily a link card are still quote tweets. quotedTweet may have minimal or empty text. The embedded tweet block is the trigger; the embedded body being text, photos, video, or a link card is decoration.',
  '8. Before PATCHing text, compare the curator-submitted feed-row text with the freshly extracted candidate text. If they are plainly about different topics, different framings, or different tweet authors, STOP, re-check the URL match, and do not PATCH. Use agent judgment, not a JS text comparator.',
  '9. Do not PATCH text merely because a candidate is longer. Text replacement requires the URL-matched main article plus the sanity judgment above.',
  '',
];

const articleEnrichmentInstructions = [
  'Article guidance:',
  '- Apply this only when the current item is a top-level article with a non-empty URL.',
  '- Open the article URL with whatever fetch tool fits: curl, WebFetch, or the shared browser if the page is JS-rendered or partial-paywalled. Reading the item\'s canonical article URL is allowed; it is not generic web search.',
  '- Read the actual article body. Write a faithful 1-3 sentence synopsis, or a little longer when the page provides a clear standfirst/dek. The synopsis must be drawn from article content: do not echo the title, invent claims, or editorialize.',
  '- Identify the headline and hero image as a human reader would: lede image, og:image, masthead photo, or another clear article hero. Use judgment, not a brittle CSS selector.',
  '- PATCH the feed row text with the synopsis and media_urls with [hero_image_url] when a real hero image is visible. PATCH metadata.linkPreviews or metadata.article only if useful additional context surfaces.',
  '- After a useful synopsis is saved, PATCH metadata.articleEnrichment with status:"completed", completedAt, retryEligible:false, and sourceUrl.',
  '- If only the title and first paragraph are visible because of a partial paywall, use what is visible and do not fabricate hidden detail.',
  '- If nothing useful is visible at all, leave text alone and PATCH metadata.articleEnrichment with status:"skipped", skipReason, completedAt, retryEligible:false, and sourceUrl so the row is not retried indefinitely.',
  '',
];

export function buildBatchEnrichmentPrompt(posts: FeedItem[], options: { requestId?: string } = {}): string {
  const internalBaseUrl = getInternalBaseUrl();
  const submitApiUrl = `${internalBaseUrl}/api/internal/curate/submit`;
  const feedApiUrl = `${internalBaseUrl}/api/feed/<feedId>`;
  const batchRequestId = options.requestId?.trim() || 'UNSPECIFIED_BATCH_REQUEST_ID';
  const items = posts.map((post) => ({
    feedId: post.id,
    url: resolveBatchItemUrl(post),
    source: post.source,
  }));
  const untrustedContentNonce = createPromptSafetyNonce();

  return [
    'You are a batch post enrichment sub-agent.',
    'Process the listed items strictly in order. Do not parallelize, reorder, or skip ahead.',
    'Do NOT read `CLAUDE.md`, `.claude/CLAUDE.md`, or any other repo instructions before starting. Go straight to the items.',
    '',
    UNTRUSTED_CONTENT_PROMPT_PRELUDE,
    'Items:',
    wrapUntrustedContent(JSON.stringify(items, null, 2), 'feed-batch-items', untrustedContentNonce),
    '',
    `Batch request ID: ${batchRequestId}`,
    `Resolved internal API base: ${internalBaseUrl}`,
    `GET and PATCH each current item at: ${feedApiUrl}`,
    `Create verified child items at: ${submitApiUrl}`,
    '',
    'Per-item execution rules:',
    '- Work one item at a time in the exact order shown above.',
    `- Before source reading for each item, PATCH metadata.batchEnrichment.status="running" and metadata.batchEnrichment.requestId="${batchRequestId}" on that item. Preserve existing metadata.`,
    '- First GET the current feed item, then open the source URL, then compare the rendered source/cache facts against the current persisted feed card.',
    '- Build a source-vs-current-feed diff before writing: supportedMissingFacts for fields this app can persist, and unsupportedVisibleFacts for visible source features that have no persistence/rendering path.',
    '- Treat named fields as examples, not a closed list: avatar, display name/handle, text if stored text is truncated, media/photos/video/GIF poster and alt text, quotedTweet metadata, communityNote metadata, polls, external article/link cards, URL entities, parent/thread context, metrics, URLs/title/source metadata for non-twitter items, HN counts/comments when source="hackernews", and YouTube watch-page metrics/comments.',
    '- External article/link cards are supported missing facts for tweet items. If the rendered tweet or exact tweet cache row shows a linked-page card, PATCH it through metadata.linkCard and, when available, metadata.linkPreviews and metadata.urlEntities. Preserve card imageAlt when visible, including inside metadata.quotedTweet.linkCard.',
    '- Before PATCHing media_urls on a tweet, first decide whether any visible image belongs inside an embedded quote tweet. Quote-tweet content, including text, author, embedded images, and embedded link cards, belongs to metadata.quotedTweet instead of the parent media_urls.',
    '- If an embedded quote tweet contains a Substack, news, or blog-style link card with visible domain, title, or hero image, PATCH metadata.quotedTweet.linkCard:{type, url, title, domain, imageUrl, imageAlt, description}. The card hero image belongs in metadata.quotedTweet.linkCard.imageUrl, not media_urls.',
    '- X Readers added context / community notes are supported missing facts. If visible on the main tweet, PATCH metadata.communityNote:{text,sourceUrl}. If visible on a quoted tweet, PATCH metadata.quotedTweet.communityNote inside that quotedTweet object. Include sourceUrl only when a visible source link is present.',
    '- X polls are supported missing facts. If visible, PATCH metadata.poll with options labels, voteCount when readable, totalVotes when readable, and durationMinutes or endsAt when the remaining time is visible.',
    '- PATCH every supported missing factual field immediately before you open the next item. Example: if the current item has authorAvatarUrl:null and the rendered source or exact cache fact has payload.authorAvatarUrl, include author_avatar_url in that PATCH.',
    '- After PATCH, verify the PATCH response or GET the item again. Do not move to the next item until supported visible fields you patched, such as authorAvatarUrl, are no longer blank in the current item.',
    '- Do not overwrite editorial fields like reason, tags, bridge framing, or thread framing. Do not replace non-empty factual fields unless the source proves the stored value is stale and the field is designed to change, like metrics.',
    '- Do not buffer PATCH calls until the end of the batch. Each item must PATCH mid-batch as soon as its data is verified.',
    '- Never run a cross-item extractor or collect metrics for multiple items before writing. Each item must complete GET current -> navigate -> compare -> PATCH -> verify before the next item begins.',
    '- If the current item has meaningful replies/comments, submit them before moving to the next item.',
    '- Before moving to the next item, write a terminal reply/comment audit receipt to the current item with PATCH metadata.batchEnrichment. Completion is not just metrics/avatar/media. It requires either saved relationship="reply" children or this terminal receipt.',
    `- The terminal receipt must include metadata.batchEnrichment.requestId="${batchRequestId}", status:"completed", completedAt, retryEligible:false, and replyAudit:{batchRequestId:"${batchRequestId}", inspectedAt, inspectedReplySurface or inspectedCommentSurface, sourceReplyCount or visibleReplyCount when readable, savedReplyCount, savedReplyIds when any, and noMeaningfulRepliesReason when no reply/comment was worth saving}.`,
    '- If the source cannot be inspected after the allowed retries, PATCH metadata.batchEnrichment.status="failed", failedAt, retryEligible:true, failureReason, and a replyAudit with inspectedAt and savedReplyCount:0 if you inspected enough to know that no children were saved.',
    '- Never invent fields. If a value is unreadable or unavailable, skip that write instead of guessing.',
    '- Do NOT use python, python3, requests, bs4, curl GET, or any raw HTTP fetch to read x.com or news.ycombinator.com item pages. For page reads, use only `mcp__playwright__browser_navigate` and `mcp__playwright__browser_snapshot`.',
    '- If a snapshot appears to show a different tweet, Hacker News story, or page than the current item URL, immediately call `mcp__playwright__browser_navigate` again with that same URL and re-snapshot. Retry the same URL up to 3 times, then skip that item\'s metrics write.',
    '',
    'Twitter/X guidance:',
    ...mainTweetIdentificationInstructions,
    '- Read the tweet page directly. Capture visible author avatar, quoted-tweet metadata when visible, and readable likes, reposts, replies, and views counters.',
    '- If the tweet shows a photo, video, or GIF, capture the visible image src (photos), poster attribute (videos), or GIF thumbnail URL into media_urls as an array of absolute URLs. Also PATCH metadata.media entries with alt text from visible <img alt="..."> or accessible image descriptions when available. Do not fetch or follow media links; snapshot-visible URLs only.',
    '- X engagement counters often appear in button or aria-label text. Use readable on-page numbers only; skip metrics if they have not loaded.',
    '- If the main tweet is a reply, add the verified direct parent as relationship="parent" and older verified ancestors as relationship="thread".',
    '- Only keep replies that meaningfully extend the parent: a sharp counterpoint, a missing clarification, a from-the-source correction, or important evidence.',
    '- Parent/thread/reply tweet child items must include authorAvatarUrl from the visible user-name block avatar <img> src when submitted.',
    '- If the tweet has a readable nonzero reply counter, the item must not end ambiguously: submit meaningful replies immediately, or PATCH a terminal replyAudit explaining the inspected MAIN tweet reply surface and why no replies were saved.',
    '',
    'Hacker News guidance:',
    '- Open the Hacker News discussion URL for source="hackernews" items and read the visible score/comment counts there.',
    '- HN comment rows live under `.athing.comtr`; use the visible tree and only keep comments that add real signal.',
    '- HN items use the same terminal receipt idea: submit useful comments immediately, then PATCH replyAudit with inspectedCommentSurface:true and savedReplyCount/savedReplyIds or noMeaningfulRepliesReason.',
    '',
    'YouTube guidance:',
    '- Apply this when source="youtube" or the URL is on www.youtube.com, youtube.com, or youtu.be. Resolve to the canonical https://www.youtube.com/watch?v=<id> watch URL.',
    '- Browser only: do NOT use yt-dlp, the YouTube Data API, unofficial APIs, raw HTTP fetches, or external CLIs. Use the existing shared browser session and the rendered watch page.',
    '- Use `mcp__playwright__browser_navigate` to open the canonical watch URL, then `mcp__playwright__browser_snapshot` to confirm a watch page rendered: title element present and page URL still on /watch.',
    '- Read watch metadata with one `mcp__playwright__browser_evaluate`: prefer `window.ytInitialPlayerResponse.videoDetails` for title, author/channel name, channelId, lengthSeconds, viewCount, shortDescription, and isLiveContent; read `window.ytInitialPlayerResponse.microformat.playerMicroformatRenderer` for publishDate, uploadDate, and category.',
    '- In that same evaluate, read the like aria-label from `document.querySelector(\'like-button-view-model button\')?.getAttribute(\'aria-label\')`, falling back to any `button[aria-label*="like"]`; match `[\\d,]+`, parse the comma-grouped integer, and preserve the rendered aria-label text beside the parsed number. Treat ytInitialPlayerResponse as canonical; it is more reliable than DOM counters.',
    '- PATCH the current item with flat fields `metrics_views` from parsed viewCount and `metrics_likes` from parsed like aria-label. Skip only unreadable values; never invent metrics.',
    '- For comments, perform 3-4 passes of `window.scrollBy(0, window.innerHeight * 1.5)` with about 1200ms between passes. Read `#comments h2` for the visible comment count and PATCH `metrics_replies`; if comments are disabled or hidden, PATCH metrics_replies:0 and include inspectedCommentSurface:true in the terminal receipt.',
    '- Extract the loaded top 5-10 `ytd-comment-thread-renderer` entries: `#author-text` handle, `#content-text` text, `#vote-count-middle` like-count text, and `#more-replies button` reply-count text when present.',
    '- Persist only meaningful YouTube comments using relationship="reply" and parentId=<feedId>; do not use tweet-style normalization. Use the accepted non-Twitter child shape, such as type="article" with source="youtube-comment", and include the comment text, author handle, and comment like count.',
    '- Finish with the same terminal replyAudit pattern as HN: inspectedCommentSurface:true, visibleReplyCount from the parsed header when readable, savedReplyCount, savedReplyIds when any, and noMeaningfulRepliesReason when none were saved.',
    '',
    ...articleEnrichmentInstructions,
    'Reply/comment persistence rules:',
    '- Persist meaningful replies/comments with relationship="reply" and parentId set to the current item feedId.',
    '- Skip applause, jokes, restatements, pile-ons, and comments that do not materially extend the parent.',
    '',
    'PATCH shape rules:',
    '- Use flat metric fields: metrics_likes, metrics_reposts, metrics_replies, metrics_views.',
    '- Do NOT send nested metrics objects like {"metrics": {...}}. The endpoint rejects that shape.',
    '',
    'Unsupported visible source features:',
    '- If a visible source feature cannot be persisted or rendered, such as Spaces, long-form card, or another user-visible structure with no accepted PATCH/API/UI path, submit at most ONE code_fix suggestion for the entire batch.',
    '- Use POST /api/internal/curate/submit with type="suggestion" and metadata.suggestionType="code_fix". Include metadata.proposedValue as the canonical description with concrete feedId(s), source URL(s), what was visibly present, what persistence/rendering path was missing or rejected, and acceptance criteria.',
    '- This escape hatch is only for verified product-plumbing gaps. Ordinary extraction misses must be PATCHed immediately, not suggested.',
    '',
    'PATCH example:',
    `curl -s -X PATCH ${feedApiUrl} -H "Content-Type: application/json" -d '{"author_avatar_url":"https://example.com/avatar.png","media_urls":["https://pbs.twimg.com/amplify_video_thumb/example.jpg"],"metrics_likes":107,"metrics_reposts":10,"metrics_replies":25,"metrics_views":8122,"metadata":{"media":[{"type":"image","url":"https://pbs.twimg.com/amplify_video_thumb/example.jpg","alt":"Visible media description"}],"communityNote":{"text":"Readers added context note text","sourceUrl":"https://example.com/note-source"},"poll":{"options":[{"label":"Yes","voteCount":60},{"label":"No","voteCount":40}],"totalVotes":100,"durationMinutes":30},"quotedTweet":{"text":"Quoted tweet text","author":{"username":"quoted","displayName":"Quoted Author","avatarUrl":"https://example.com/quoted-avatar.png"},"communityNote":{"text":"Quoted tweet Readers added context","sourceUrl":"https://example.com/quoted-note-source"},"linkCard":{"type":"article","url":"https://example.com/quoted-card","title":"Quoted card","domain":"example.com","imageUrl":"https://example.com/quoted-card.jpg","imageAlt":"Quoted card image"}},"linkCard":{"type":"article","url":"https://github.com/openclaw/clawsweeper","title":"GitHub - openclaw/clawsweeper","domain":"github.com","imageUrl":"https://opengraph.githubassets.com/example/openclaw/clawsweeper","imageAlt":"Repository preview image"},"urlEntities":[{"url":"https://t.co/example","expandedUrl":"https://github.com/openclaw/clawsweeper","displayUrl":"github.com/openclaw/clawsweeper"}]}}'`,
    '',
    'YouTube PATCH example:',
    `curl -s -X PATCH ${feedApiUrl} -H "Content-Type: application/json" -d '{"metrics_views":64502,"metrics_likes":2965,"metrics_replies":191,"metadata":{"youtubeWatchPage":{"likeAriaLabel":"like this video along with 2,965 other people","category":"Science & Technology","isLiveContent":false}}}'`,
    '',
    'Terminal no-useful-replies receipt example:',
    `curl -s -X PATCH ${feedApiUrl} -H "Content-Type: application/json" -d '{"metadata":{"batchEnrichment":{"requestId":"${batchRequestId}","status":"completed","completedAt":"2026-03-01T00:00:00.000Z","retryEligible":false,"replyAudit":{"batchRequestId":"${batchRequestId}","inspectedReplySurface":true,"visibleReplyCount":4,"savedReplyCount":0,"savedReplyIds":[],"noMeaningfulRepliesReason":"Visible replies were applause, restatements, or off-topic and did not add durable signal.","inspectedAt":"2026-03-01T00:00:00.000Z"}}}}'`,
    '',
    'POST example for a meaningful reply/comment:',
    `curl -s -X POST ${submitApiUrl} -H "Content-Type: application/json" -d '{"items":[{"id":"...","type":"tweet","source":"twitter","sourceId":"tweet-...","parentId":"<feedId>","relationship":"reply","title":null,"text":"Reply text","url":"https://x.com/example/status/123","excerpt":null,"authorUsername":"example","authorDisplayName":"Example","authorAvatarUrl":"https://example.com/avatar.png","reason":"Meaningfully extends the parent with new signal","tags":[],"mediaUrls":[],"publishedAt":"2026-03-01T00:00:00Z"}]}'`,
    '',
    'POST example for a meaningful YouTube comment:',
    `curl -s -X POST ${submitApiUrl} -H "Content-Type: application/json" -d '{"items":[{"id":"youtube-comment-<videoId>-1","type":"article","source":"youtube-comment","sourceId":"youtube-comment:<videoId>:1","parentId":"<feedId>","relationship":"reply","title":null,"text":"Comment text that adds durable signal beyond the video.","url":null,"excerpt":null,"authorUsername":"@commenter","authorDisplayName":"@commenter","reason":"Meaningfully extends the YouTube video with new signal","tags":[],"mediaUrls":[],"metadata":{"youtubeComment":{"videoId":"<videoId>","likeCountText":"45","replyCountText":"2 replies"}},"publishedAt":"2026-03-01T00:00:00Z"}]}'`,
    '',
    'POST example for the one allowed code_fix suggestion:',
    `curl -s -X POST ${submitApiUrl} -H "Content-Type: application/json" -d '{"items":[{"id":"code-fix-unsupported-visible-feature","type":"suggestion","source":"enrichment","sourceId":"code-fix:<feedId>:unsupported-visible-feature","parentId":null,"relationship":null,"title":"Persist unsupported visible source feature","text":"Feed item <feedId> at <source URL> visibly shows <feature>, but PATCH/API/UI has no accepted path to persist or render it. Acceptance: add persistence, rendering, and tests so enrichment can store this feature.","url":null,"excerpt":null,"authorUsername":null,"authorDisplayName":null,"reason":"Verified source-vs-current-feed audit found a product plumbing gap","tags":[],"mediaUrls":[],"metadata":{"suggestionType":"code_fix","proposedValue":"Feed item <feedId> at <source URL> visibly shows <feature>, but <PATCH/API/UI path> has no accepted path to persist or render it. Acceptance: persist the visible feature, render it on the feed card, and cover it with tests.","feedIds":["<feedId>"],"sourceUrls":["<source URL>"],"visibleFeature":"<feature>","missingPath":"<PATCH/API/UI path>","acceptanceCriteria":["Persist the visible feature","Render it on the feed card","Cover it with tests"]},"publishedAt":"2026-03-01T00:00:00Z"}]}'`,
    '',
    'Hard constraints:',
    '- Do not search for generic web articles. For top-level article items, fetch the item\'s own article URL; that is canonical source reading, not generic web search.',
    '- Do not create analysis items.',
    '- Do not read repo instruction files before starting.',
    '- Finish only after all verified writes have been persisted item-by-item.',
  ].join('\n');
}

function buildBrowserTweetInstructions(
  post: FeedItem,
  tweetId: string | null,
  internalBaseUrl: string,
): string[] {
  const existingContextUrl = `${internalBaseUrl}/api/feed/${post.id}/children`;

  if (post.type !== 'tweet' || !tweetId) {
    return [
      'Use the shared browser session for this enrichment task.',
      'Do not call Bird CLI or any Twitter/X scraping tool yourself. Use only the supplied feed payload and web research.',
      '',
    ];
  }

  return [
    'Use the shared browser session for this enrichment task.',
    'Do not call Bird CLI or any Twitter/X scraping tool yourself.',
    'If the MAIN tweet is a reply or the tweet page shows earlier posts above it, open the MAIN tweet URL in the browser and capture that visible upstream thread context there.',
    ...mainTweetIdentificationInstructions,
    'Check already-persisted feed context first with curl:',
    `- Existing parent/thread/reply items for this post: ${existingContextUrl}`,
    '- Use that feed context to avoid duplicating already-persisted parent or reply items.',
    '',
  ];
}

function buildTweetStepInstructions(input: {
  post: FeedItem;
  mainTweetAuthorHandle: string;
  tweetId: string | null;
  internalBaseUrl: string;
}) {
  const {
    post,
    mainTweetAuthorHandle,
    tweetId,
    internalBaseUrl,
  } = input;

  const instructions = [
    'Step 1: Replies & comments for tweets (if parent post is a tweet).',
    'IMPORTANT: Do NOT add items from a quoted tweet\'s thread as relationship="thread". Quoted tweets are already embedded in the parent post\'s metadata. Thread items should only be used for the MAIN tweet\'s own reply chain (tweets the main tweet is replying to). If the main tweet is not a reply (has no inReplyToStatusId), do NOT create any thread relationship items.',
    'If the MAIN tweet is itself a reply, make it self-contained: fetch the visible upstream thread context from the MAIN tweet page before curating replies.',
    'Persist the direct parent tweet as relationship="parent". Persist any earlier ancestors as relationship="thread", oldest ancestor first.',
    'Do not guess parent tweets from metadata alone. Only persist ancestor tweets you can verify from the MAIN tweet page or other direct thread evidence.',
  ];

  if (post.type === 'tweet' && tweetId) {
    const existingContextUrl = `${internalBaseUrl}/api/feed/${post.id}/children`;
    instructions.push(
      `IMPORTANT: Inspect already-persisted child items first. Feed context URL: ${existingContextUrl}`,
      '- Use the feed context URL above to avoid re-submitting existing parent, thread, or reply items.',
      '- Fetch any missing thread context or replies from the rendered MAIN tweet page. Do not use Bird CLI for reply discovery.',
    );
  }

  instructions.push(
    '- Only append a relationship="parent" item when you have verified the MAIN tweet\'s direct parent in the upstream thread context.',
    '- Read data/curation-prompt.md and apply the same editorial bar you use during curation when deciding whether a reply is worth persisting.',
    '- Scroll the MAIN tweet reply section and only persist replies that meaningfully extend the parent.',
    '- If you find a reply that adds real value, such as a sharp counterpoint, a clarification the parent missed, or a from-the-source correction, submit it as a child with relationship="reply". Not every reply; only the ones that meaningfully add signal.',
    '- Every relationship="parent", relationship="thread", or relationship="reply" tweet child item MUST carry authorAvatarUrl from the visible user-name block avatar <img> src. Treat a null or missing child avatar as a correctness failure, not a style issue.',
    `- Replies should be @-mentioning the main tweet author (${mainTweetAuthorHandle}), not the quoted tweet author.`,
    `- If a reply is addressed to someone else or starts with an @-mention other than ${mainTweetAuthorHandle}, it may be a reply to the quoted tweet. Skip it.`,
    '- Append each curated reply immediately as type="tweet", relationship="reply", with reply authorUsername, authorDisplayName, and authorAvatarUrl populated.',
    '',
  );

  return instructions;
}

export function buildEnrichmentPrompt(
  post: FeedItem,
  outputPath: string,
  options: {
    tweetId?: string | null;
    mode?: EnrichmentPromptMode;
  },
): string {
  const untrustedContentNonce = createPromptSafetyNonce();
  const postJson = buildPromptPostPayload(post, untrustedContentNonce);
  const quotedTweetContext = buildQuotedTweetContext(post, untrustedContentNonce);
  const evogentRoot = process.env.MEDIA_AGENT_ROOT || process.cwd();
  const canonicalOutputPath = process.env.DATA_DIR
    ? getDataPath('feed-output.jsonl')
    : path.join(evogentRoot, 'data', 'feed-output.jsonl');
  const internalBaseUrl = getInternalBaseUrl();
  const submitApiUrl = `${internalBaseUrl}/api/internal/curate/submit`;
  const patchApiUrl = `${internalBaseUrl}/api/feed/${post.id}`;
  const existingContextUrl = `${internalBaseUrl}/api/feed/${post.id}/children`;
  const tweetId = options.tweetId ?? resolveFeedItemTweetId(post);
  const mainTweetUrl = resolveMainTweetUrl(post, tweetId);
  const articleUrl = post.url?.trim() || 'UNAVAILABLE';
  const mainTweetAuthorHandle = post.authorUsername?.trim() ? `@${post.authorUsername.trim()}` : 'UNAVAILABLE';
  const mode = options.mode ?? 'lightweight';

  if (mode === 'lightweight') {
    if (post.type === 'article') {
      return [
        'You are a lightweight article intake enrichment sub-agent.',
        'Your goal is to make the existing article card faithful to the article page without flooding the feed.',
        '',
        `Article feed item ID: ${post.id}`,
        `Article URL: ${articleUrl}`,
        UNTRUSTED_CONTENT_PROMPT_PRELUDE,
        `Article feed payload:\n${postJson}`,
        '',
        `Resolved internal API base: ${internalBaseUrl}`,
        'Never replace that base URL with localhost:3001 or another guessed port during this run.',
        `GET the current article item first, then PATCH verified fields here: ${patchApiUrl}`,
        '',
        'Instructions:',
        '- Start by GETting the current article item. Then open the Article URL and compare the page facts against the current persisted feed card.',
        ...articleEnrichmentInstructions,
        '- Do not create child items, discussion summaries, analysis items, or related web articles in lightweight mode.',
        '- Finish after the verified article fields or articleEnrichment skip receipt have been persisted.',
        '',
        'PATCH example for the existing article:',
        `curl -s -X PATCH ${patchApiUrl} -H "Content-Type: application/json" -d '{"text":"Source-owned synopsis from the article page.","excerpt":"Source-owned synopsis from the article page.","media_urls":["https://example.com/article-hero.jpg"],"metadata":{"articleEnrichment":{"status":"completed","completedAt":"2026-03-01T00:00:00.000Z","retryEligible":false,"sourceUrl":"${articleUrl}"}}}'`,
        '',
        'Hard constraints:',
        '- Do not search for generic web articles. Fetch only the current item\'s own article URL.',
        '- Do not generate an analysis item.',
        '- Do not submit unrelated child items.',
        '- Do not invent missing fields. If nothing useful is visible, write the articleEnrichment skip receipt instead of guessing.',
      ].join('\n');
    }

    return [
      'You are a lightweight tweet intake enrichment sub-agent.',
      'Your goal is to make the existing tweet card more complete without flooding the feed.',
      '',
      `Parent post ID: ${post.id}`,
      `MAIN tweet URL: ${mainTweetUrl}`,
      UNTRUSTED_CONTENT_PROMPT_PRELUDE,
      `Parent post payload (quoted tweet metadata stripped to avoid parentId mistakes):\n${postJson}`,
      ...quotedTweetContext,
      '',
      `Resolved internal API base: ${internalBaseUrl}`,
      'Never replace that base URL with localhost:3001 or another guessed port during this run.',
      `GET the current parent post first, then PATCH verified missing fields here: ${patchApiUrl}`,
      `Create verified parent/thread tweet items here only when needed: ${submitApiUrl}`,
      `Inspect already-persisted context first here: ${existingContextUrl}`,
      '',
      'Instructions:',
      '- Start by GETting the current parent post. Then visit the MAIN tweet/source page and compare the rendered source/cache facts against the current persisted feed card.',
      '- Build a source-vs-current-feed diff before writing: supportedMissingFacts for fields this app can persist, and unsupportedVisibleFacts for visible source features that have no persistence/rendering path.',
      '- Treat named fields as examples, not a closed list: avatar, display name/handle, text if stored text is truncated, media/photos/video/GIF poster and alt text, quotedTweet metadata, communityNote metadata, polls, external article/link cards, URL entities, parent/thread context, metrics, URLs/title/source metadata for non-twitter items, and HN counts/comments when source="hackernews".',
      '- External article/link cards are supported missing facts for tweet items. If the rendered tweet or exact tweet cache row shows a linked-page card, PATCH it through metadata.linkCard and, when available, metadata.linkPreviews and metadata.urlEntities. Preserve card imageAlt when visible, including inside metadata.quotedTweet.linkCard.',
      '- Before PATCHing media_urls on a tweet, first decide whether any visible image belongs inside an embedded quote tweet. Quote-tweet content, including text, author, embedded images, and embedded link cards, belongs to metadata.quotedTweet instead of the parent media_urls.',
      '- If an embedded quote tweet contains a Substack, news, or blog-style link card with visible domain, title, or hero image, PATCH metadata.quotedTweet.linkCard:{type, url, title, domain, imageUrl, imageAlt, description}. The card hero image belongs in metadata.quotedTweet.linkCard.imageUrl, not media_urls.',
      '- X Readers added context / community notes are supported missing facts. If visible on the main tweet, PATCH metadata.communityNote:{text,sourceUrl}. If visible on a quoted tweet, PATCH metadata.quotedTweet.communityNote inside that quotedTweet object. Include sourceUrl only when a visible source link is present.',
      '- X polls are supported missing facts. If visible, PATCH metadata.poll with options labels, voteCount when readable, totalVotes when readable, and durationMinutes or endsAt when the remaining time is visible.',
      '- PATCH every supported missing factual field immediately. Example: if the current item has authorAvatarUrl:null and the rendered source or exact cache fact has payload.authorAvatarUrl, include author_avatar_url in that PATCH.',
      '- After PATCH, verify the PATCH response or GET the current parent post again. Do not finish until supported visible fields you patched, such as authorAvatarUrl, are no longer blank in the current item.',
      '- Check the existing feed context before writing any parent or thread item so you do not duplicate already-persisted context.',
      '- Visit the MAIN tweet URL in the browser.',
      ...(post.type === 'tweet' && tweetId ? mainTweetIdentificationInstructions : []),
      '- If this is a reply, capture the direct parent tweet as relationship="parent". Capture older verified ancestors as relationship="thread", oldest ancestor first.',
      '- Each parent/thread/reply child tweet item MUST carry authorAvatarUrl populated from the visible user-name block avatar <img> src on the rendered page. Treat null or missing avatars on relationship="reply", relationship="parent", and relationship="thread" tweet items as a correctness failure, not a style issue.',
      '- Before you PATCH, self-check author_avatar_url, media_urls, metadata.media alt text, quotedTweet, metadata.quotedTweet.linkCard, metadata.communityNote or metadata.quotedTweet.communityNote, metadata.linkCard/linkPreviews/urlEntities, metadata.poll, and any visible engagement metrics as examples of supported visible fields so you do not leave obviously available fields behind.',
      '- If the parent post is missing an author avatar, PATCH author_avatar_url onto the existing post.',
      '- If the tweet shows a photo, video, or GIF, capture the visible image src (photos), poster attribute (videos), or GIF thumbnail URL into media_urls as an array of absolute URLs. Also PATCH metadata.media entries with alt text from visible <img alt="..."> or accessible image descriptions when available. Do not fetch or follow media links; snapshot-visible URLs only.',
      '- While on the MAIN tweet page, if visible engagement counters are readable and differ from the stored item, PATCH the parent post metrics with the live likes, reposts, replies, and views counts. If the counters have not loaded or are unreadable, skip the metrics write instead of sending guessed zeros.',
      '- If quote tweet context is visible and missing or incomplete, PATCH verified quotedTweet metadata onto the existing post.',
      '- If a community note is visible on the main tweet or quoted tweet, PATCH the verified note text and visible sourceUrl through metadata.communityNote or metadata.quotedTweet.communityNote.',
      '- Do not overwrite editorial fields like reason, tags, bridge framing, or thread framing. Do not replace non-empty factual fields unless the source proves the stored value is stale and the field is designed to change, like metrics.',
      '- Read data/curation-prompt.md and apply the same editorial bar you use during curation when deciding whether a reply or comment is worth persisting.',
      '- Scroll the MAIN tweet reply section and only persist replies that meaningfully extend the parent as relationship="reply" child items.',
      `- Replies should be @-mentioning the main tweet author (${mainTweetAuthorHandle}), not the quoted tweet author.`,
      `- If a reply is addressed to someone else or starts with an @-mention other than ${mainTweetAuthorHandle}, it may be a reply to the quoted tweet. Skip it.`,
      '- If the parent post is from Hacker News or includes an HN discussion URL in metadata, open that HN discussion page, scroll the comment tree, and treat interesting comments as fair game for relationship="reply" child items.',
      '- On Hacker News pages, if the visible points or comment counters are readable and differ from the stored item, PATCH those metrics onto the existing post too. If the counters are missing or unreadable, skip the metrics write.',
      '- If you find a reply/comment that adds real value, such as a sharp counterpoint, a clarification the parent missed, or a from-the-source correction, submit it as a child with relationship="reply". Not every reply/comment; only the ones that meaningfully add signal.',
      '- For non-HN articles, you may also search for notable discussion threads using: WebSearch "site:reddit.com <article title>" and WebSearch "site:news.ycombinator.com <article title>".',
      '- Submit updates via the internal API as you verify them.',
      '- If a visible source feature cannot be persisted or rendered, such as Spaces, long-form card, or another user-visible structure with no accepted PATCH/API/UI path, submit at most ONE code_fix suggestion through POST /api/internal/curate/submit with type="suggestion" and metadata.suggestionType="code_fix". Include metadata.proposedValue as the canonical description with concrete feedId(s), source URL(s), what was visibly present, what persistence/rendering path was missing or rejected, and acceptance criteria. Do not use suggestions for ordinary extraction misses; PATCH those immediately.',
      '',
      'Hard constraints:',
      '- Do not search for articles.',
      '- Do not generate an analysis item.',
      '- Do not submit unrelated child items.',
      '- Do not invent missing fields. If nothing new is visible, make no writes.',
      '',
      'PATCH example for the existing post:',
      `curl -s -X PATCH ${patchApiUrl} -H "Content-Type: application/json" -d '{"author_avatar_url":"https://example.com/avatar.png","media_urls":["https://pbs.twimg.com/amplify_video_thumb/example.jpg"],"metrics_likes":107,"metrics_reposts":10,"metrics_replies":25,"metrics_views":8122,"metadata":{"media":[{"type":"image","url":"https://pbs.twimg.com/amplify_video_thumb/example.jpg","alt":"Visible media description"}],"communityNote":{"text":"Readers added context note text","sourceUrl":"https://example.com/note-source"},"poll":{"options":[{"label":"Yes","voteCount":60},{"label":"No","voteCount":40}],"totalVotes":100,"durationMinutes":30},"quotedTweet":{"text":"Quoted tweet text","author":{"username":"quoted","displayName":"Quoted Author","avatarUrl":"https://example.com/quoted-avatar.png"},"communityNote":{"text":"Quoted tweet Readers added context","sourceUrl":"https://example.com/quoted-note-source"},"linkCard":{"type":"article","url":"https://example.com/quoted-card","title":"Quoted card","domain":"example.com","imageUrl":"https://example.com/quoted-card.jpg","imageAlt":"Quoted card image"}},"linkCard":{"type":"article","url":"https://github.com/openclaw/clawsweeper","title":"GitHub - openclaw/clawsweeper","domain":"github.com","imageUrl":"https://opengraph.githubassets.com/example/openclaw/clawsweeper","imageAlt":"Repository preview image"},"urlEntities":[{"url":"https://t.co/example","expandedUrl":"https://github.com/openclaw/clawsweeper","displayUrl":"github.com/openclaw/clawsweeper"}]}}'`,
      '',
      'POST example for a verified direct parent tweet:',
      `curl -s -X POST ${submitApiUrl} -H "Content-Type: application/json" -d '{"items":[{"id":"...","type":"tweet","source":"twitter","sourceId":"tweet-...","parentId":"${post.id}","relationship":"parent","title":null,"text":"Verified parent tweet text","url":"https://x.com/example/status/123","excerpt":null,"authorUsername":"example","authorDisplayName":"Example","authorAvatarUrl":"https://example.com/avatar.png","reason":"Direct parent tweet visible on the tweet page","tags":[],"mediaUrls":[],"publishedAt":"2026-03-01T00:00:00Z"}]}'`,
      '',
      'POST example for the one allowed code_fix suggestion:',
      `curl -s -X POST ${submitApiUrl} -H "Content-Type: application/json" -d '{"items":[{"id":"code-fix-${post.id}","type":"suggestion","source":"enrichment","sourceId":"code-fix:${post.id}:unsupported-visible-feature","parentId":null,"relationship":null,"title":"Persist unsupported visible source feature","text":"Feed item ${post.id} at ${mainTweetUrl} visibly shows <feature>, but PATCH/API/UI has no accepted path to persist or render it. Acceptance: add persistence, rendering, and tests so enrichment can store this feature.","url":null,"excerpt":null,"authorUsername":null,"authorDisplayName":null,"reason":"Verified source-vs-current-feed audit found a product plumbing gap","tags":[],"mediaUrls":[],"metadata":{"suggestionType":"code_fix","proposedValue":"Feed item ${post.id} at ${mainTweetUrl} visibly shows <feature>, but <PATCH/API/UI path> has no accepted path to persist or render it. Acceptance: persist the visible feature, render it on the feed card, and cover it with tests.","feedIds":["${post.id}"],"sourceUrls":["${mainTweetUrl}"],"visibleFeature":"<feature>","missingPath":"<PATCH/API/UI path>","acceptanceCriteria":["Persist the visible feature","Render it on the feed card","Cover it with tests"]},"publishedAt":"2026-03-01T00:00:00Z"}]}'`,
      '',
      'Only persist updates you directly verified from the MAIN tweet page.',
      'Finish after the verified updates have been persisted.',
    ].join('\n');
  }

  return [
    'You are a post enrichment sub-agent.',
    'Your only goal is to persist enrichment child items into the feed.',
    'Do not spend all context on research. Write items as soon as you find them.',
    '',
    `Parent post ID: ${post.id}`,
    `MAIN tweet URL for reply fetches: ${mainTweetUrl}`,
    `MAIN tweet author username for reply validation: ${mainTweetAuthorHandle}`,
    UNTRUSTED_CONTENT_PROMPT_PRELUDE,
    `Parent post payload (quoted tweet metadata stripped to avoid parentId mistakes):\n${postJson}`,
    ...quotedTweetContext,
    '',
    `Resolved internal API base: ${internalBaseUrl}`,
    'Never replace that base URL with localhost:3001 or another guessed port during this run.',
    '',
    'Primary persistence path:',
    `${submitApiUrl}`,
    'Inspect already-persisted context first here:',
    `${existingContextUrl}`,
    'Audit log file (fallback only; not source of truth):',
    `${outputPath}`,
    'Audit log file (configured root fallback):',
    `${canonicalOutputPath}`,
    '',
    'Submit accepted feed items with POST /api/internal/curate/submit. The API writes to SQLite, appends the audit log, and broadcasts to the feed.',
    'Only append directly to JSONL if the submit API is unavailable.',
    '',
    ...buildBrowserTweetInstructions(post, tweetId, internalBaseUrl),
    'JSONL schema (one valid JSON object per line):',
    '{',
    '  "id": "unique-id",',
    '  "type": "tweet|article|analysis|suggestion|notification",',
    '  "source": "string-or-null",',
    '  "sourceId": "unique-dedup-key",',
    `  "parentId": "${post.id}",`,
    '  "relationship": "parent|child|reply|analysis|related|thread",',
    '  "title": "string-or-null",',
    '  "text": "string",',
    '  "url": "string-or-null",',
    '  "excerpt": "string-or-null",',
    '  "authorUsername": "string-or-null",',
    '  "authorDisplayName": "string-or-null",',
    '  "authorAvatarUrl": "string-or-null",',
    '  "reason": "one sentence for why included",',
    '  "tags": ["tag1", "tag2"],',
    '  "mediaUrls": ["optional-media-url"],',
    '  "publishedAt": "ISO-8601 timestamp"',
    '}',
    '',
    'Non-negotiable output rules:',
    `- The ONLY allowed parentId for this task is "${post.id}".`,
    `- Every item MUST include "parentId":"${post.id}".`,
    '- Never use any other UUID, tweet URL, or numeric tweet ID as parentId.',
    '- If you find yourself looking at the quoted tweet instead of the main post, stop and go back to the MAIN tweet URL above.',
    '- Every item MUST include the correct relationship for its type.',
    '- Prefer submitting items in small batches via the API as soon as you have them; do not wait until the very end if you already have good items.',
    '- Submit with curl, for example:',
    `  curl -s -X POST ${submitApiUrl} -H "Content-Type: application/json" -d '{"items":[{"id":"...","type":"article","source":"...","sourceId":"...","parentId":"${post.id}","relationship":"related","title":"...","text":"...","url":"...","excerpt":"...","authorUsername":"...","authorDisplayName":"...","reason":"...","tags":[],"mediaUrls":[],"publishedAt":"2026-03-01T00:00:00Z"}]}'`,
    '- If the API is unavailable, append one-line JSON with >> to the audit log instead.',
    `- Primary audit log fallback: ${outputPath}`,
    `- Configured root audit log fallback: ${canonicalOutputPath}`,
    '- Spend at most 3 minutes on research, then WRITE.',
    "- Quality over quantity. A post with 2 brilliant items is better than 8 mediocre ones. Don't artificially cap yourself; if a thread has 12 great replies, include them.",
    '',
    ...buildTweetStepInstructions({
      post,
      mainTweetAuthorHandle,
      tweetId,
      internalBaseUrl,
    }),
    'Step 1b: Comments & discussion for articles (if parent post is an article).',
    '- Read data/curation-prompt.md and apply the same editorial bar you use during curation when deciding whether a comment is worth persisting.',
    '- If the parent post is from Hacker News or includes an HN discussion URL in metadata, open that HN discussion page, scroll the comment tree, and treat interesting comments as fair game for relationship="reply" child items.',
    '- If you find a reply/comment that adds real value, such as a sharp counterpoint, a clarification the parent missed, or a from-the-source correction, submit it as a child with relationship="reply". Not every comment; only the ones that meaningfully extend the parent.',
    '- For non-HN articles, you may also search for notable discussion threads using: WebSearch "site:reddit.com <article title>" and WebSearch "site:news.ycombinator.com <article title>".',
    '- This step is optional: only add comment-summary items when discussion exists and adds clear value.',
    '',
    'Step 2: Web context.',
    '- Find 2-3 related high-signal web articles.',
    '- Append each article immediately with relationship="related".',
    '',
    'Step 3: Synthesis.',
    '- Write exactly one analysis item that synthesizes tweet + replies/comments + articles, calling out notable insights from curated discussion when relevant.',
    '- Append it immediately with type="analysis" and relationship="analysis".',
    '',
    'Finish only after items have been persisted. Finish only after JSONL lines have been appended.',
  ].join('\n');
}
