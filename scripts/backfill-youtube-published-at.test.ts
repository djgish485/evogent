import assert from 'node:assert';
import { describe, test } from 'node:test';
import { parseYoutubePublishedAtMs } from './backfill-youtube-published-at';

describe('parseYoutubePublishedAtMs', () => {
  const referenceMs = Date.parse('2026-05-04T12:00:00.000Z');

  test('parses relative YouTube labels', () => {
    assert.strictEqual(
      parseYoutubePublishedAtMs('2 days ago', { referenceMs }),
      Date.parse('2026-05-02T12:00:00.000Z'),
    );
    assert.strictEqual(
      parseYoutubePublishedAtMs('13 hours ago', { referenceMs }),
      Date.parse('2026-05-03T23:00:00.000Z'),
    );
    assert.strictEqual(
      parseYoutubePublishedAtMs('just now', { referenceMs }),
      referenceMs,
    );
  });

  test('parses absolute YouTube labels', () => {
    assert.strictEqual(
      parseYoutubePublishedAtMs('April 23', { referenceMs }),
      Date.parse('2026-04-23T00:00:00.000Z'),
    );
    assert.strictEqual(
      parseYoutubePublishedAtMs('2026-04-15', { referenceMs }),
      Date.parse('2026-04-15T00:00:00.000Z'),
    );
  });
});
