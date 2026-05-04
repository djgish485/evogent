import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  deletePreferenceById,
  deletePreferenceByFeedItem,
  getNegativePreferences,
  getPreferencesPage,
  getPositivePreferences,
  getRecentPreferences,
  getPreferenceStats,
  insertPreference,
  updatePreferenceReason,
  updatePreferenceReasonByFeedItem,
} from './preferences';
import { getDb } from './client';

type GlobalWithDb = typeof globalThis & {
  evogentDb?: {
    close: () => void;
  };
};

const globalWithDb = globalThis as GlobalWithDb;

describe('preferences repository', () => {
  let originalDbPath: string | undefined;
  let tempDir = '';

  beforeEach(async () => {
    originalDbPath = process.env.MEDIA_AGENT_DB_PATH;
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evogent-preferences-test-'));

    if (globalWithDb.evogentDb) {
      globalWithDb.evogentDb.close();
      delete globalWithDb.evogentDb;
    }

    process.env.MEDIA_AGENT_DB_PATH = path.join(tempDir, 'media-agent.db');
  });

  afterEach(async () => {
    if (globalWithDb.evogentDb) {
      globalWithDb.evogentDb.close();
      delete globalWithDb.evogentDb;
    }

    if (originalDbPath === undefined) {
      delete process.env.MEDIA_AGENT_DB_PATH;
    } else {
      process.env.MEDIA_AGENT_DB_PATH = originalDbPath;
    }

    if (tempDir) {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('insertPreference stores and returns rows in positive/negative queries', () => {
    insertPreference({
      feedItemId: 'feed-1',
      signalType: 'liked',
      source: 'app_thumbsup',
      text: 'I like technical AI infrastructure posts',
      reason: 'more practical engineering details',
      weight: 1.2,
    });

    insertPreference({
      feedItemId: 'feed-2',
      signalType: 'disliked',
      source: 'app_thumbsdown',
      text: 'Celebrity gossip thread',
      reason: 'too off-topic',
      weight: 1.5,
    });

    const positives = getPositivePreferences(20);
    const negatives = getNegativePreferences(20);

    assert.strictEqual(positives.length, 1);
    assert.strictEqual(positives[0]?.signalType, 'liked');
    assert.strictEqual(positives[0]?.reason, 'more practical engineering details');

    assert.strictEqual(negatives.length, 1);
    assert.strictEqual(negatives[0]?.signalType, 'disliked');
    assert.strictEqual(negatives[0]?.reason, 'too off-topic');
  });

  test('getPreferenceStats aggregates by type and source', () => {
    insertPreference({
      signalType: 'liked',
      source: 'app_thumbsup',
      text: 'Prefer policy analysis with concrete data',
      weight: 1.0,
    });

    insertPreference({
      signalType: 'hidden',
      source: 'twitter_archive_mute',
      text: 'Low-quality rage-bait',
      weight: 1.0,
    });

    const stats = getPreferenceStats();
    assert.strictEqual(stats.total, 2);
    assert.strictEqual(stats.byType.liked, 1);
    assert.strictEqual(stats.byType.hidden, 1);
    assert.strictEqual(stats.bySource.app_thumbsup, 1);
    assert.strictEqual(stats.bySource.twitter_archive_mute, 1);
  });

  test('deletePreferenceByFeedItem removes matching preference rows', () => {
    insertPreference({
      feedItemId: 'feed-3',
      signalType: 'liked',
      source: 'app_thumbsup',
      text: 'Value long-form explainers',
    });

    const removed = deletePreferenceByFeedItem('feed-3', 'liked');
    assert.strictEqual(removed, true);

    const positives = getPositivePreferences(20);
    assert.strictEqual(positives.length, 0);
  });

  test('getRecentPreferences can filter for entries with reasons', () => {
    insertPreference({
      signalType: 'liked',
      source: 'app_thumbsup',
      text: 'Detailed policy analysis',
      reason: 'strongly aligned with my interests',
    });

    insertPreference({
      signalType: 'disliked',
      source: 'app_thumbsdown',
      text: 'Low-value content',
    });

    const reasoned = getRecentPreferences({
      limit: 20,
      onlyWithReason: true,
      since: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });

    assert.strictEqual(reasoned.length, 1);
    assert.strictEqual(reasoned[0]?.reason, 'strongly aligned with my interests');
  });

  test('getPreferencesPage returns paginated rows with feed metadata', () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO feed (
        id, type, source, source_id, title, text, published_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'feed-preference-page-1',
      'article',
      'unit_test',
      null,
      'Example feed title',
      'Example feed text body',
      new Date().toISOString(),
    );

    insertPreference({
      feedItemId: 'feed-preference-page-1',
      signalType: 'liked',
      source: 'app_thumbsup',
      text: 'Preference linked to feed item',
    });

    const page = getPreferencesPage({
      signalType: 'liked',
      offset: 0,
      limit: 10,
    });

    assert.ok(page.items.length >= 1);
    assert.strictEqual(page.offset, 0);
    assert.strictEqual(page.limit, 10);
    assert.strictEqual(typeof page.total, 'number');
    assert.strictEqual(typeof page.hasMore, 'boolean');
    assert.strictEqual(page.items[0]?.feedTitle, 'Example feed title');
  });

  test('deletePreferenceById removes preference and matching interaction', () => {
    const db = getDb();
    const feedItemId = 'feed-preference-delete-1';

    db.prepare(`
      INSERT INTO feed (
        id, type, source, source_id, title, text, published_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      feedItemId,
      'article',
      'unit_test',
      null,
      'Delete preference fixture',
      'Delete preference fixture body',
      new Date().toISOString(),
    );

    db.prepare(`
      INSERT INTO interactions (feed_item_id, action)
      VALUES (?, ?)
    `).run(feedItemId, 'like');

    const insertedId = insertPreference({
      feedItemId,
      signalType: 'liked',
      source: 'app_thumbsup',
      text: 'Preference targeted for deletePreferenceById test',
    });

    const removed = deletePreferenceById(insertedId);
    assert.ok(removed);
    assert.strictEqual(removed?.id, insertedId);

    const row = db.prepare(`
      SELECT COUNT(*) AS count
      FROM preferences
      WHERE id = ?
    `).get(insertedId) as { count: number };
    assert.strictEqual(row.count, 0);

    const interactionRow = db.prepare(`
      SELECT COUNT(*) AS count
      FROM interactions
      WHERE feed_item_id = ? AND action = 'like'
    `).get(feedItemId) as { count: number };
    assert.strictEqual(interactionRow.count, 0);
  });

  test('updatePreferenceReason updates and clears a preference reason', () => {
    const insertedId = insertPreference({
      feedItemId: 'feed-update-reason-1',
      signalType: 'disliked',
      source: 'app_thumbsdown',
      text: 'Initial preference text',
    });

    const updated = updatePreferenceReason(insertedId, 'Not relevant to my interests');
    assert.ok(updated);
    assert.strictEqual(updated?.reason, 'Not relevant to my interests');

    const cleared = updatePreferenceReason(insertedId, '   ');
    assert.ok(cleared);
    assert.strictEqual(cleared?.reason, null);

    const missing = updatePreferenceReason('missing-id', 'anything');
    assert.strictEqual(missing, null);
  });

  test('updatePreferenceReasonByFeedItem updates reason for existing feed preference', () => {
    const feedItemId = 'feed-update-reason-by-feed-item-1';
    insertPreference({
      feedItemId,
      signalType: 'disliked',
      source: 'app_thumbsdown',
      text: 'Initial preference text',
    });

    const updated = updatePreferenceReasonByFeedItem(
      feedItemId,
      'disliked',
      'Too much clickbait',
    );
    assert.strictEqual(updated, true);

    const row = getDb().prepare(`
      SELECT reason
      FROM preferences
      WHERE feed_item_id = ? AND signal_type = ?
      LIMIT 1
    `).get(feedItemId, 'disliked') as { reason: string | null };
    assert.strictEqual(row.reason, 'Too much clickbait');

    const missing = updatePreferenceReasonByFeedItem('missing-feed-item', 'disliked', 'any');
    assert.strictEqual(missing, false);
  });
});
