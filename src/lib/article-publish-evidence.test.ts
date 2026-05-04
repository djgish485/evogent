import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { validateArticlePublishEvidence } from './article-publish-evidence';

describe('validateArticlePublishEvidence', () => {
  const nowMs = Date.parse('2026-04-28T05:17:12.000Z');

  test('rejects direct web articles that use submit time without source evidence', () => {
    assert.equal(
      validateArticlePublishEvidence({
        type: 'article',
        source: 'apnews',
        url: 'https://apnews.com/article/example',
        publishedAt: '2026-04-28T05:17:09.461Z',
        metadata: {},
        nowMs,
      }),
      'Direct web article publishedAt looks like submit time; include metadata.publishEvidence with source datePublished/article:published_time, or mark it unavailable/uncertain.',
    );
  });

  test('rejects source metadata that disagrees with publishedAt', () => {
    assert.equal(
      validateArticlePublishEvidence({
        type: 'article',
        source: 'apnews',
        url: 'https://apnews.com/article/example',
        publishedAt: '2026-04-28T05:17:09.461Z',
        metadata: {
          article: {
            datePublished: '2026-04-27T16:32:46Z',
            dateModified: '2026-04-28T00:47:30Z',
          },
        },
        nowMs,
      }),
      'Article publishedAt must match source-owned publish metadata when datePublished/article:published_time evidence is present.',
    );
  });

  test('accepts source metadata that matches publishedAt', () => {
    assert.equal(
      validateArticlePublishEvidence({
        type: 'article',
        source: 'apnews',
        url: 'https://apnews.com/article/example',
        publishedAt: '2026-04-27T16:32:46.000Z',
        metadata: {
          publishEvidence: {
            status: 'verified',
            source: 'article:published_time',
            publishedAt: '2026-04-27T16:32:46Z',
          },
        },
        nowMs,
      }),
      null,
    );
  });

  test('rejects verified publish evidence without a parseable timestamp', () => {
    assert.equal(
      validateArticlePublishEvidence({
        type: 'article',
        source: 'apnews',
        url: 'https://apnews.com/article/example',
        publishedAt: '2026-04-27T16:32:46.000Z',
        metadata: {
          publishEvidence: {
            status: 'verified',
            source: 'article:published_time',
          },
        },
        nowMs,
      }),
      'Verified article publish evidence must include a parseable source publishedAt/datePublished timestamp.',
    );
  });

  test('accepts explicit uncertainty when source publish metadata was unavailable', () => {
    assert.equal(
      validateArticlePublishEvidence({
        type: 'article',
        source: 'example',
        url: 'https://example.com/no-metadata',
        publishedAt: '2026-04-28T05:17:09.461Z',
        metadata: {
          publishEvidence: {
            status: 'unavailable',
            reason: 'No article:published_time or datePublished field on fetched page.',
          },
        },
        nowMs,
      }),
      null,
    );
  });
});
