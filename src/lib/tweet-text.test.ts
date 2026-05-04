import assert from 'node:assert/strict';
import test from 'node:test';
import {
  stripLeadingReplyMentions,
  stripLinkPreviewUrlsForDisplay,
  stripQuotedTweetUrlsForDisplay,
  stripTrailingTweetMediaUrls,
  truncateTextForCollapsedDisplay,
} from '@/lib/tweet-text';
import type { FeedItem } from '@/types/feed';

function tweetItem(
  text: string,
  includeQuotedTweet: boolean,
  options?: { mediaUrls?: string[]; hasMetadataMedia?: boolean },
): Pick<FeedItem, 'type' | 'text' | 'metadata' | 'mediaUrls'> {
  return {
    type: 'tweet',
    text,
    mediaUrls: options?.mediaUrls ?? [],
    metadata: includeQuotedTweet
      ? {
          quotedTweet: {
            id: 'quote-1',
            text: 'Quoted tweet',
            author: { username: 'quoted_user' },
          },
          ...(options?.hasMetadataMedia ? { media: [{ type: 'image', url: 'https://pbs.twimg.com/media/1.jpg' }] } : {}),
        }
      : options?.hasMetadataMedia
        ? {
            media: [{ type: 'image', url: 'https://pbs.twimg.com/media/1.jpg' }],
          }
        : null,
  };
}

test('stripQuotedTweetUrlsForDisplay removes quoted status URL and trims trailing whitespace', () => {
  const input = `Line one\nhttps://x.com/example/status/1234567890\n`;
  const output = stripQuotedTweetUrlsForDisplay(tweetItem(input, true));
  assert.equal(output, 'Line one');
});

test('stripQuotedTweetUrlsForDisplay keeps URLs when no quoted tweet metadata exists', () => {
  const input = 'Read this https://x.com/example/status/1234567890';
  const output = stripQuotedTweetUrlsForDisplay(tweetItem(input, false));
  assert.equal(output, input);
});

test('stripQuotedTweetUrlsForDisplay removes only status URLs and preserves other URLs', () => {
  const input = [
    'Context https://example.com/story',
    'Quoted https://twitter.com/some_user/status/987654321',
    'Docs https://docs.example.com',
  ].join('\n');
  const output = stripQuotedTweetUrlsForDisplay(tweetItem(input, true));
  assert.equal(output, 'Context https://example.com/story\nQuoted \nDocs https://docs.example.com');
});

test('stripLinkPreviewUrlsForDisplay removes previewed URLs and preserves other links', () => {
  const item: Pick<FeedItem, 'type' | 'text' | 'metadata'> = {
    type: 'tweet',
    text: [
      'Iran update',
      'https://www.reuters.com/world/middle-east/iranian-hardline-clerics-seek-swift-naming-of-new-supreme-leader/',
      'Docs https://docs.example.com/report',
    ].join('\n'),
    metadata: {
      linkPreviews: [
        {
          url: 'https://www.reuters.com/world/middle-east/iranian-hardline-clerics-seek-swift-naming-of-new-supreme-leader/',
          title: 'Reuters story',
          domain: 'reuters.com',
        },
      ],
      urlEntities: [
        {
          url: 'https://t.co/reuters123',
          expandedUrl: 'https://www.reuters.com/world/middle-east/iranian-hardline-clerics-seek-swift-naming-of-new-supreme-leader/',
        },
      ],
    },
  };

  const output = stripLinkPreviewUrlsForDisplay(item);
  assert.equal(output, 'Iran update\nDocs https://docs.example.com/report');
});

test('truncateTextForCollapsedDisplay backs up before a URL instead of slicing through it', () => {
  const prefix = 'A'.repeat(275);
  const text = `${prefix} https://www.reuters.com/world/middle-east/iranian-hardline-clerics-seek-swift-naming-of-new-supreme-leader/`;

  const output = truncateTextForCollapsedDisplay(text, { charLimit: 280, lineLimit: 6 });

  assert.equal(output, prefix);
  assert.ok(!output.includes('https://'));
});

test('stripQuotedTweetUrlsForDisplay removes trailing media t.co URLs when tweet has mediaUrls', () => {
  const input = 'Screenshots from the article https://t.co/abcd1234';
  const output = stripQuotedTweetUrlsForDisplay(
    tweetItem(input, false, { mediaUrls: ['https://pbs.twimg.com/media/1.jpg'] }),
  );
  assert.equal(output, 'Screenshots from the article');
});

test('stripQuotedTweetUrlsForDisplay removes trailing media t.co URLs when tweet has metadata media', () => {
  const input = 'Screenshots from the article\nhttps://t.co/abcd1234';
  const output = stripQuotedTweetUrlsForDisplay(
    tweetItem(input, false, { hasMetadataMedia: true }),
  );
  assert.equal(output, 'Screenshots from the article');
});

test('stripQuotedTweetUrlsForDisplay keeps trailing t.co URLs when tweet has no media', () => {
  const input = 'Source link https://t.co/abcd1234';
  const output = stripQuotedTweetUrlsForDisplay(tweetItem(input, false));
  assert.equal(output, input);
});

test('stripTrailingTweetMediaUrls removes one or more trailing t.co media URLs', () => {
  const input = 'Tweet body https://t.co/abcd1234 https://t.co/efgh5678';
  assert.equal(stripTrailingTweetMediaUrls(input), 'Tweet body');
});

test('stripLeadingReplyMentions removes a single leading mention', () => {
  const input = '@sentdefender Russia has been sharing intel';
  const output = stripLeadingReplyMentions(input);
  assert.equal(output, 'Russia has been sharing intel');
});

test('stripLeadingReplyMentions removes multiple leading mentions', () => {
  const input = '@user1 @user2  Reply text';
  const output = stripLeadingReplyMentions(input);
  assert.equal(output, 'Reply text');
});

test('stripLeadingReplyMentions preserves non-leading mentions', () => {
  const input = 'Reply text for @user2 in the middle';
  const output = stripLeadingReplyMentions(input);
  assert.equal(output, input);
});

test('stripLeadingReplyMentions falls back to original text when mentions consume all content', () => {
  const input = '@user1 @user2';
  const output = stripLeadingReplyMentions(input);
  assert.equal(output, input);
});
