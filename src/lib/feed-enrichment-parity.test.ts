import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { getDb } from './db/client';
import { insertOrIgnoreFeedItem, type FeedInsertInput } from './db/feed';
import { applyCachedItemEnrichment } from './feed-enrichment';
import type { FeedItem } from '@/types/feed';

type GlobalWithDb = typeof globalThis & {
  evogentDb?: {
    close: () => void;
  };
};

interface CacheItemFixture {
  source: string;
  sourceId: string;
  url: string | null;
  title: string | null;
  authorUsername: string | null;
  authorDisplayName: string | null;
  publishedAtMs: number | null;
  payload: Record<string, unknown>;
  fetchedAtMs: number;
  expiresAtMs: number;
  seenByCurationAtMs: number | null;
}

interface ParityFixture {
  fixtureVersion: 1;
  capturedAt: string;
  source: string;
  sourceId: string;
  cacheItem: CacheItemFixture;
  preEngineFeedRow: FeedInsertInput;
  historicalFeedRow: Record<string, unknown>;
  expectedFeedRow: Record<string, unknown>;
  intentionalImprovements: string[];
}

const globalWithDb = globalThis as GlobalWithDb;
const fixtureSources = ['twitter', 'hackernews', 'substack', 'youtube'] as const;

// Historical parity corpus generated on 2026-05-02 from data/feed-output.jsonl
// joined to browse_cache_items. Do not regenerate in CI; update fixtures manually
// only when the cache extractor's expected shape intentionally changes.
const parityCapturedAt = '2026-05-02T15:00:00.000Z';
const parityFixturesRoot = path.join(process.cwd(), 'src/lib/fixtures/feed-enrichment/parity');
const parityFieldPaths = [
  'title',
  'url',
  'excerpt',
  'text',
  'authorUsername',
  'authorDisplayName',
  'authorAvatarUrl',
  'mediaUrls',
  'metrics.likes',
  'metrics.reposts',
  'metrics.replies',
  'metrics.views',
  'metadata.quotedTweet',
  'metadata.linkCard',
  'metadata.communityNote',
  'metadata.linkPreviews',
  'metadata.urlEntities',
  'metadata.article',
  'metadata.hnUrl',
  'parentId',
  'relationship',
] as const;

function closeDb() {
  if (globalWithDb.evogentDb) {
    globalWithDb.evogentDb.close();
    delete globalWithDb.evogentDb;
  }
}

function getPath(input: unknown, dottedPath: string): unknown {
  let current: unknown = input;
  for (const segment of dottedPath.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function toFixtureValue(value: unknown): unknown {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function setPath(target: Record<string, unknown>, dottedPath: string, value: unknown) {
  const segments = dottedPath.split('.');
  let current = target;
  for (const segment of segments.slice(0, -1)) {
    const existing = current[segment];
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
  current[segments[segments.length - 1]] = toFixtureValue(value);
}

function pickFeedFields(item: FeedItem | Record<string, unknown> | null): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const fieldPath of parityFieldPaths) {
    setPath(picked, fieldPath, getPath(item, fieldPath));
  }
  return picked;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function diffFieldPaths(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  return parityFieldPaths.filter((fieldPath) => (
    stableJson(getPath(before, fieldPath)) !== stableJson(getPath(after, fieldPath))
  ));
}

function loadParityFixtures(): ParityFixture[] {
  return fixtureSources.flatMap((source) => {
    const sourceDir = path.join(parityFixturesRoot, source);
    return fs.readdirSync(sourceDir)
      .filter((fileName) => fileName.endsWith('.json'))
      .sort()
      .map((fileName) => JSON.parse(
        fs.readFileSync(path.join(sourceDir, fileName), 'utf8'),
      ) as ParityFixture);
  });
}

function insertCacheItem(cacheItem: CacheItemFixture) {
  getDb().prepare(`
    INSERT OR REPLACE INTO browse_cache_items (
      source,
      source_id,
      url,
      title,
      author_username,
      author_display_name,
      published_at_ms,
      payload_json,
      fetched_at_ms,
      expires_at_ms,
      seen_by_curation_at_ms
    ) VALUES (
      @source,
      @source_id,
      @url,
      @title,
      @author_username,
      @author_display_name,
      @published_at_ms,
      @payload_json,
      @fetched_at_ms,
      @expires_at_ms,
      @seen_by_curation_at_ms
    )
  `).run({
    source: cacheItem.source,
    source_id: cacheItem.sourceId,
    url: cacheItem.url,
    title: cacheItem.title,
    author_username: cacheItem.authorUsername,
    author_display_name: cacheItem.authorDisplayName,
    published_at_ms: cacheItem.publishedAtMs,
    payload_json: JSON.stringify(cacheItem.payload),
    fetched_at_ms: cacheItem.fetchedAtMs,
    expires_at_ms: cacheItem.expiresAtMs,
    seen_by_curation_at_ms: cacheItem.seenByCurationAtMs,
  });
}

function resetParityRows() {
  const db = getDb();
  db.prepare('DELETE FROM feed WHERE parent_id IS NOT NULL').run();
  db.prepare('DELETE FROM feed').run();
  db.prepare('DELETE FROM browse_cache_items').run();
}

describe('feed enrichment historical cache parity corpus', () => {
  let originalDbPath: string | undefined;
  let tempDir = '';

  beforeEach(async () => {
    originalDbPath = process.env.MEDIA_AGENT_DB_PATH;
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evogent-feed-parity-test-'));
    closeDb();
    process.env.MEDIA_AGENT_DB_PATH = path.join(tempDir, 'media-agent.db');
  });

  afterEach(async () => {
    closeDb();
    if (originalDbPath === undefined) {
      delete process.env.MEDIA_AGENT_DB_PATH;
    } else {
      process.env.MEDIA_AGENT_DB_PATH = originalDbPath;
    }
    if (tempDir) {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('replays 50 captured cache/feed pairs per source through applyCachedItemEnrichment', () => {
    const fixtures = loadParityFixtures();
    assert.equal(fixtures.length, 200);

    for (const source of fixtureSources) {
      assert.equal(fixtures.filter((fixture) => fixture.source === source).length, 50);
    }

    for (const fixture of fixtures) {
      assert.equal(fixture.fixtureVersion, 1);
      assert.equal(fixture.capturedAt, parityCapturedAt);
      assert.equal(fixture.cacheItem.source, fixture.source);
      assert.equal(fixture.cacheItem.sourceId, fixture.sourceId);
      assert.deepEqual(
        diffFieldPaths(fixture.historicalFeedRow, fixture.expectedFeedRow),
        fixture.intentionalImprovements,
        `${fixture.source}:${fixture.sourceId} intentional improvement annotations are stale`,
      );

      resetParityRows();
      insertCacheItem(fixture.cacheItem);
      assert.equal(insertOrIgnoreFeedItem(fixture.preEngineFeedRow), true);

      const enriched = applyCachedItemEnrichment(fixture.preEngineFeedRow.id ?? '');
      assert.ok(enriched, `${fixture.source}:${fixture.sourceId} should enrich a feed row`);
      assert.deepEqual(
        pickFeedFields(enriched),
        fixture.expectedFeedRow,
        `${fixture.source}:${fixture.sourceId} cache parity drifted`,
      );
    }
  });
});
