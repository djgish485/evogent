import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { formatCompactTimestamp, getFeedItemCompactTimestampSource } from './compact-timestamp';

describe('formatCompactTimestamp', () => {
  const now = Date.parse('2026-03-29T12:00:00.000Z');

  test('renders recent timestamps in the compact relative style', () => {
    assert.equal(formatCompactTimestamp('2026-03-29T11:59:30.000Z', now), 'now');
    assert.equal(formatCompactTimestamp('2026-03-29T11:54:00.000Z', now), '6m');
    assert.equal(formatCompactTimestamp('2026-03-29T09:00:00.000Z', now), '3h');
    assert.equal(formatCompactTimestamp('2026-03-27T12:00:00.000Z', now), '2d');
  });

  test('falls back to month and day for older timestamps', () => {
    assert.equal(formatCompactTimestamp('2026-03-20T12:00:00.000Z', now), 'Mar 20');
  });

  test('prefers publishedAt before createdAt for feed items', () => {
    assert.equal(
      getFeedItemCompactTimestampSource({
        createdAt: '2026-03-29T11:54:00.000Z',
        publishedAt: '2026-03-29T09:00:00.000Z',
      }),
      '2026-03-29T09:00:00.000Z',
    );
  });

  test('falls back to publishedAt when createdAt is blank', () => {
    assert.equal(
      getFeedItemCompactTimestampSource({
        createdAt: '   ',
        publishedAt: '2026-03-29T09:00:00.000Z',
      }),
      '2026-03-29T09:00:00.000Z',
    );
  });
});
