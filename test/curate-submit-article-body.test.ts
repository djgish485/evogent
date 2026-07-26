import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { getDb } from '../src/lib/db/client';

type GlobalWithDb = typeof globalThis & {
  evogentDb?: {
    close: () => void;
  };
};

type SubmitRouteModule = {
  POST: (request: Request) => Promise<Response>;
};

type SubmitResponse = {
  accepted?: number;
  duplicates?: number;
  completionDeferred?: boolean;
  completionDeferredReason?: string | null;
  completionRejected?: boolean;
  completionRejectedReason?: string | null;
  errors?: Array<{
    scope?: string;
    index?: number;
    sourceId?: string | null;
    error?: string;
  }>;
  acceptedIds?: string[];
  duplicateSourceIds?: string[];
};

const articleBodySourceSynopsisError = [
  'Article body must carry the source\'s own synopsis (og:description, subtitle, or opening paragraph).',
  'The body cannot be the article title or title + curator boilerplate.',
  'Fetch the URL and use the source-owned text verbatim, or drop the candidate.',
].join(' ');
const missingRealPublishDateError = (source: string) => (
  `Submission missing real publish date. Source <${source}> requires a published_at from the original source. `
  + 'Pull it from browse_cache_items.published_at_ms or fetch it from the URL before submitting.'
);

const globalWithDb = globalThis as GlobalWithDb;

function closeDb() {
  if (globalWithDb.evogentDb) {
    globalWithDb.evogentDb.close();
    delete globalWithDb.evogentDb;
  }
}

describe('curate submit article body validation', { concurrency: false }, () => {
  let originalDataDir: string | undefined;
  let originalStateDir: string | undefined;
  let originalDbPath: string | undefined;
  let originalPort: string | undefined;
  let originalOrchestratorUrl: string | undefined;
  let originalFeedNotifyUrl: string | undefined;
  let originalFetch: typeof fetch;
  let tempDir = '';
  let routeModule: SubmitRouteModule;

  before(async () => {
    const originalCwd = process.cwd();
    originalDataDir = process.env.DATA_DIR;
    originalStateDir = process.env.MEDIA_AGENT_STATE_DIR;
    originalDbPath = process.env.MEDIA_AGENT_DB_PATH;
    originalPort = process.env.PORT;
    originalOrchestratorUrl = process.env.ORCHESTRATOR_INTERNAL_URL;
    originalFeedNotifyUrl = process.env.INTERNAL_FEED_NOTIFY_URL;
    originalFetch = globalThis.fetch;
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evogent-article-body-submit-test-'));
    closeDb();

    process.env.DATA_DIR = path.join(tempDir, 'data');
    process.env.MEDIA_AGENT_STATE_DIR = path.join(tempDir, 'agent-state');
    process.env.MEDIA_AGENT_DB_PATH = path.join(tempDir, 'data', 'media-agent.db');
    process.env.PORT = '3172';
    process.env.ORCHESTRATOR_INTERNAL_URL = 'http://127.0.0.1:3172';
    process.env.INTERNAL_FEED_NOTIFY_URL = 'http://127.0.0.1:3172/api/internal/feed-notify';

    globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;

    const routeModuleUrl = `${pathToFileURL(path.join(originalCwd, 'src/app/api/internal/curate/submit/route.ts')).href}?case=${Date.now()}-${randomUUID()}`;
    routeModule = await import(routeModuleUrl) as SubmitRouteModule;
  });

  after(async () => {
    closeDb();
    globalThis.fetch = originalFetch;

    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;

    if (originalStateDir === undefined) delete process.env.MEDIA_AGENT_STATE_DIR;
    else process.env.MEDIA_AGENT_STATE_DIR = originalStateDir;

    if (originalDbPath === undefined) delete process.env.MEDIA_AGENT_DB_PATH;
    else process.env.MEDIA_AGENT_DB_PATH = originalDbPath;

    if (originalPort === undefined) delete process.env.PORT;
    else process.env.PORT = originalPort;

    if (originalOrchestratorUrl === undefined) delete process.env.ORCHESTRATOR_INTERNAL_URL;
    else process.env.ORCHESTRATOR_INTERNAL_URL = originalOrchestratorUrl;

    if (originalFeedNotifyUrl === undefined) delete process.env.INTERNAL_FEED_NOTIFY_URL;
    else process.env.INTERNAL_FEED_NOTIFY_URL = originalFeedNotifyUrl;

    if (tempDir) {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  async function submitItems(items: Array<Record<string, unknown>>): Promise<{ status: number; body: SubmitResponse }> {
    const response = await routeModule.POST(new Request('http://127.0.0.1:3172/api/internal/curate/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    }));

    return {
      status: response.status,
      body: await response.json() as SubmitResponse,
    };
  }

  test('rejects article submissions when text is just the title', async () => {
    const title = 'Planning Is Unsolved';
    const sourceId = `article-body-title-only-${randomUUID()}`;
    const result = await submitItems([{
      id: `ma-${sourceId}`,
      type: 'article',
      source: 'web',
      sourceId,
      title,
      text: '  planning   is unsolved  ',
      url: `https://example.com/articles/${sourceId}`,
      publishedAt: '2026-03-08T10:00:00.000Z',
      metadata: {},
    }]);

    assert.equal(result.status, 400);
    assert.equal(result.body.accepted, 0);
    assert.equal(result.body.duplicates, 0);
    assert.equal(result.body.errors?.length, 1);
    assert.equal(result.body.errors?.[0]?.scope, 'item');
    assert.equal(result.body.errors?.[0]?.sourceId, sourceId);
    assert.equal(result.body.errors?.[0]?.error, articleBodySourceSynopsisError);
  });

  test('rejects article submissions when text is title plus only HN boilerplate', async () => {
    const title = 'cohix code-agents architecture';
    const sourceId = `article-body-hn-boilerplate-${randomUUID()}`;
    const result = await submitItems([{
      id: `ma-${sourceId}`,
      type: 'article',
      source: 'hackernews',
      sourceId,
      title,
      text: `${title} Hacker News surfaced this as a low-noise signal in the current cache; score 17, comments 3.`,
      url: `https://example.com/articles/${sourceId}`,
      publishedAt: '2026-03-08T10:00:00.000Z',
      metadata: {
        hnUrl: 'https://news.ycombinator.com/item?id=12345',
      },
    }]);

    assert.equal(result.status, 400);
    assert.equal(result.body.accepted, 0);
    assert.equal(result.body.errors?.[0]?.error, articleBodySourceSynopsisError);
  });

  test('accepts rich OpenClaw skill article cards even when text mirrors the title', async () => {
    const title = 'Daily Brief';
    const sourceId = `evogent-skill:daily-brief:${Math.floor(Date.now() / 1000)}`;
    const result = await submitItems([{
      id: `ma-openclaw-rich-skill-${randomUUID()}`,
      type: 'article',
      source: 'openclaw',
      sourceId,
      title,
      text: title,
      publishedAt: '2026-03-08T10:00:00.000Z',
      metadata: {
        source: 'openclaw',
        mcpAppHtml: '<section><h1>Daily Brief</h1><div>Rich grid content</div></section>',
        openClaw: {
          bundleDir: path.join(tempDir, 'skill-runs', 'daily-brief'),
          skill: 'daily-brief',
          outputPath: path.join(tempDir, 'skill-runs', 'daily-brief', 'output.mcpapp.html'),
        },
      },
    }]);

    assert.equal(result.status, 200);
    assert.equal(result.body.accepted, 1);
    assert.equal(result.body.duplicates, 0);
    assert.deepEqual(result.body.errors, []);
  });

  test('still rejects OpenClaw article cards without a skill marker when text mirrors the title', async () => {
    const title = 'OpenClaw Digest';
    const sourceId = `openclaw-rich-without-skill-${randomUUID()}`;
    const result = await submitItems([{
      id: `ma-openclaw-no-skill-${randomUUID()}`,
      type: 'article',
      source: 'openclaw',
      sourceId,
      title,
      text: title,
      publishedAt: '2026-03-08T10:00:00.000Z',
      metadata: {
        source: 'openclaw',
        mcpAppHtml: '<section><h1>OpenClaw Digest</h1></section>',
        openClaw: {},
      },
    }]);

    assert.equal(result.status, 400);
    assert.equal(result.body.accepted, 0);
    assert.equal(result.body.errors?.[0]?.sourceId, sourceId);
    assert.equal(result.body.errors?.[0]?.error, articleBodySourceSynopsisError);
  });

  test('rejects YouTube submissions without source-owned publishedAt', async () => {
    const videoId = `video-no-published-at-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    const result = await submitItems([{
      id: `ma-submit-youtube-no-published-at-${randomUUID()}`,
      type: 'article',
      source: 'youtube',
      sourceId: videoId,
      title: 'Missing YouTube publish date',
      text: 'A source-owned synopsis explains what this YouTube video covers.',
      url: `https://www.youtube.com/watch?v=${videoId}`,
      metadata: {
        thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        publishDate: '2026-03-07T09:00:00.000Z',
      },
    }]);

    assert.equal(result.status, 400);
    assert.equal(result.body.accepted, 0);
    assert.equal(result.body.duplicates, 0);
    assert.equal(result.body.errors?.length, 1);
    assert.equal(result.body.errors?.[0]?.scope, 'item');
    assert.equal(result.body.errors?.[0]?.sourceId, videoId);
    assert.equal(result.body.errors?.[0]?.error, missingRealPublishDateError('youtube'));
  });

  test('rejects YouTube submissions that use submit time as publishedAt', async () => {
    const videoId = `video-submit-time-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    const result = await submitItems([{
      id: `ma-submit-youtube-submit-time-${randomUUID()}`,
      type: 'article',
      source: 'youtube',
      sourceId: videoId,
      title: 'Submit-time YouTube publish date',
      text: 'A source-owned synopsis explains what this YouTube video covers.',
      url: `https://www.youtube.com/watch?v=${videoId}`,
      publishedAt: new Date().toISOString(),
      metadata: {
        thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        publishDate: '2026-03-07T09:00:00.000Z',
      },
    }]);

    assert.equal(result.status, 400);
    assert.equal(result.body.accepted, 0);
    assert.equal(result.body.duplicates, 0);
    assert.equal(result.body.errors?.length, 1);
    assert.equal(result.body.errors?.[0]?.scope, 'item');
    assert.equal(result.body.errors?.[0]?.sourceId, videoId);
    assert.equal(result.body.errors?.[0]?.error, missingRealPublishDateError('youtube'));
  });

  test('allows OpenClaw skill submissions to use submit time when publishedAt is omitted', async () => {
    const sourceId = `openclaw-missing-published-at-${randomUUID()}`;
    const result = await submitItems([{
      id: `ma-${sourceId}`,
      type: 'notification',
      source: 'openclaw',
      sourceId,
      title: 'Daily Brief',
      text: 'OpenClaw skill output is generated at submit time.',
      metadata: {
        mcpAppHtml: '<article>Daily Brief output</article>',
        openClaw: {
          skill: 'daily-brief',
          bundleDir: path.join(tempDir, 'skill-runs', 'daily-brief', sourceId),
          outputPath: path.join(tempDir, 'skill-runs', 'daily-brief', sourceId, 'output.mcpapp.html'),
        },
      },
    }]);

    assert.equal(result.status, 200);
    assert.equal(result.body.accepted, 1);
    assert.deepEqual(result.body.errors, []);
  });

  test('rewrites legacy curation source cards to openclaw without clobbering explicit sources', async () => {
    const curationSourceId = `curator-source-alias-${randomUUID()}`;
    const preservedMetadataSourceId = `curator-source-preserve-${randomUUID()}`;
    const explicitSourceId = `curator-source-explicit-${randomUUID()}`;

    const result = await submitItems([
      {
        id: `ma-submit-curation-source-${randomUUID()}`,
        type: 'analysis',
        source: 'Curation',
        sourceId: curationSourceId,
        title: 'Curator source alias observation',
        text: 'A curator observation submitted with the legacy curation source should be stored as OpenClaw.',
        reason: 'Exercise curation source alias normalization',
        tags: ['test'],
        publishedAt: '2026-05-20T00:15:00.000Z',
        metadata: {
          kind: 'observation',
          bridges: ['gmail', 'web'],
        },
      },
      {
        id: `ma-submit-curation-source-preserve-${randomUUID()}`,
        type: 'analysis',
        source: 'curation',
        sourceId: preservedMetadataSourceId,
        title: 'Curator source alias with metadata source',
        text: 'An explicit metadata source should survive top-level source normalization.',
        reason: 'Exercise metadata source preservation',
        tags: ['test'],
        publishedAt: '2026-05-20T00:16:00.000Z',
        metadata: {
          source: 'custom-curator',
          mcpAppHtml: '<section>Custom curator card</section>',
        },
      },
      {
        id: `ma-submit-explicit-source-${randomUUID()}`,
        type: 'analysis',
        source: 'gmail-substack',
        sourceId: explicitSourceId,
        title: 'Explicit bridge source',
        text: 'An explicit non-curation source should not be clobbered by curator metadata.',
        reason: 'Exercise explicit source preservation',
        tags: ['test'],
        publishedAt: '2026-05-20T00:17:00.000Z',
        metadata: {
          source: 'chat-curator',
          kind: 'analysis',
        },
      },
    ]);

    assert.equal(result.status, 200);
    assert.equal(result.body.accepted, 3);
    assert.equal(result.body.duplicates, 0);
    assert.deepEqual(result.body.errors, []);

    const rows = getDb().prepare(`
      SELECT source_id AS sourceId, source, metadata
      FROM feed
      WHERE source_id IN (?, ?, ?)
    `).all(curationSourceId, preservedMetadataSourceId, explicitSourceId) as Array<{
      sourceId: string;
      source: string | null;
      metadata: string | null;
    }>;
    const bySourceId = new Map(rows.map((row) => [row.sourceId, row]));

    const normalizedAlias = bySourceId.get(curationSourceId);
    assert.equal(normalizedAlias?.source, 'openclaw');
    const normalizedAliasMetadata = JSON.parse(normalizedAlias?.metadata ?? '{}') as Record<string, unknown>;
    assert.equal(normalizedAliasMetadata.source, 'chat-curator');
    assert.equal(normalizedAliasMetadata.kind, 'observation');

    const preservedMetadataSource = bySourceId.get(preservedMetadataSourceId);
    assert.equal(preservedMetadataSource?.source, 'openclaw');
    const preservedMetadata = JSON.parse(preservedMetadataSource?.metadata ?? '{}') as Record<string, unknown>;
    assert.equal(preservedMetadata.source, 'custom-curator');

    const explicitSource = bySourceId.get(explicitSourceId);
    assert.equal(explicitSource?.source, 'gmail-substack');
  });

  test('rejects article submissions when excerpt is just the title', async () => {
    const title = 'Nature genome control knobs';
    const sourceId = `article-body-excerpt-title-${randomUUID()}`;
    const result = await submitItems([{
      id: `ma-${sourceId}`,
      type: 'article',
      source: 'web',
      sourceId,
      title,
      text: 'Researchers describe a source-owned synopsis that is distinct from the headline and useful on the feed card.',
      excerpt: title,
      url: `https://example.com/articles/${sourceId}`,
      publishedAt: '2026-03-08T10:00:00.000Z',
      metadata: {},
    }]);

    assert.equal(result.status, 400);
    assert.equal(result.body.accepted, 0);
    assert.equal(result.body.errors?.[0]?.error, articleBodySourceSynopsisError);
  });

  test('accepts article submissions with a real source synopsis', async () => {
    const sourceId = `article-body-real-synopsis-${randomUUID()}`;
    const result = await submitItems([{
      id: `ma-${sourceId}`,
      type: 'article',
      source: 'web',
      sourceId,
      title: 'Genome control knobs',
      text: 'Researchers report a compact method for tuning gene expression across cell types, using source metadata and opening-paragraph evidence to summarize the work.',
      excerpt: 'Researchers report a compact method for tuning gene expression across cell types.',
      url: 'https://example.com/',
      publishedAt: '2026-03-08T10:00:00.000Z',
      metadata: {},
    }]);

    assert.equal(result.status, 200);
    assert.equal(result.body.accepted, 1);
    assert.deepEqual(result.body.errors, []);
    assert.equal(result.body.acceptedIds?.length, 1);
  });


  test('rejects an invalid terminal receipt before inserting feed rows', async () => {
    const db = getDb();
    const sourceId = `article-invalid-summary-${randomUUID()}`;
    const itemId = `ma-${sourceId}`;
    const requestId = `openclaw-heartbeat-invalid-summary-${randomUUID()}`;
    const startedAt = new Date().toISOString();
    const feedCountBefore = db.prepare('SELECT COUNT(*) AS count FROM feed').get() as { count: number };

    db.prepare(`
      INSERT INTO curation_log (request_id, triggered_by, started_at, feed_count_before)
      VALUES (?, ?, ?, ?)
    `).run(
      requestId,
      `adaptive_heartbeat:api-test:invalid-summary-${randomUUID()}`,
      startedAt,
      feedCountBefore.count,
    );

    const response = await routeModule.POST(new Request('http://127.0.0.1:3172/api/internal/curate/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: [
          {
            id: itemId,
            type: 'article',
            source: 'web',
            sourceId,
            title: 'Accepted item with invalid summary',
            text: 'Researchers report a compact method for tuning gene expression across cell types, using source metadata and opening-paragraph evidence to summarize the work.',
            excerpt: 'Researchers report a compact method for tuning gene expression across cell types.',
            url: `https://example.com/articles/${sourceId}`,
            reason: 'Regression coverage for heartbeat completion',
            publishedAt: '2026-03-08T08:00:00.000Z',
            metadata: {
              cycleId: `curate-${randomUUID()}`,
              interest: { score: 0.62, durability: 'dated' },
            },
          },
        ],
        cycleSummary: {
          cycleId: `curate-${randomUUID()}`,
          considered: null,
          selected: 1,
          rejected: 0,
          topRejectionReasons: [],
        },
      }),
    }));
    const body = await response.json() as SubmitResponse;

    assert.equal(response.status, 422);
    assert.equal(body.accepted, 0);
    assert.equal(body.acceptedIds?.length, 0);
    assert.ok(
      body.errors?.some((error) => error.scope === 'cycleSummary'),
      'Expected invalid cycle summary to be reported with the rejected batch',
    );
    assert.equal(body.completionDeferred, false);
    assert.equal(body.completionDeferredReason, null);
    assert.equal(body.completionRejected, true);
    assert.match(
      body.completionRejectedReason ?? '',
      /completion receipt is invalid/,
    );
    const feedRow = db.prepare(`
      SELECT id
      FROM feed
      WHERE id = ?
    `).get(itemId) as { id: string } | undefined;
    assert.equal(feedRow, undefined);

    const row = db.prepare(`
      SELECT completed_at AS completedAt, items_added AS itemsAdded, completion_status AS completionStatus, completion_reason AS completionReason
      FROM curation_log
      WHERE request_id = ?
    `).get(requestId) as {
      completedAt: string | null;
      itemsAdded: number | null;
      completionStatus: string | null;
      completionReason: string | null;
    } | undefined;

    assert.ok(row, 'Expected the heartbeat cycle with an invalid receipt to remain pending in the log');
    assert.equal(row.completedAt, null);
    assert.equal(row.itemsAdded, null);
    assert.equal(row.completionStatus, null);
    assert.equal(row.completionReason, null);
  });
  test('rejects automated-cycle primary items missing metadata.interest', async () => {
    const db = getDb();
    const sourceId = `article-missing-interest-${randomUUID()}`;
    const itemId = `ma-${sourceId}`;
    const cycleId = `chat-queue-heartbeat-missing-interest-${randomUUID()}`;
    const feedCountBefore = db.prepare('SELECT COUNT(*) AS count FROM feed').get() as { count: number };
    db.prepare(`
      INSERT INTO curation_log (request_id, triggered_by, started_at, feed_count_before)
      VALUES (?, ?, ?, ?)
    `).run(
      cycleId,
      'adaptive_heartbeat:api-test:missing-interest',
      new Date().toISOString(),
      feedCountBefore.count,
    );
    const response = await routeModule.POST(new Request('http://127.0.0.1:3172/api/internal/curate/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: [
          {
            id: itemId,
            type: 'article',
            source: 'web',
            sourceId,
            title: 'Primary item without interest judgment',
            text: 'Researchers report a compact method for tuning gene expression across cell types, using source metadata and opening-paragraph evidence to summarize the work.',
            excerpt: 'Researchers report a compact method for tuning gene expression across cell types.',
            url: `https://example.com/articles/${sourceId}`,
            reason: 'Coverage for the interest submit gate',
            publishedAt: '2026-03-08T08:00:00.000Z',
            metadata: { cycleId },
          },
        ],
        cycleSummary: {
          cycleId,
          considered: 10,
          selected: 1,
          rejected: 9,
          topRejectionReasons: [],
        },
      }),
    }));
    const body = await response.json() as SubmitResponse;

    assert.equal(response.status, 400);
    assert.equal(body.accepted, 0);
    assert.ok(
      body.errors?.some((error) => error.scope === 'item' && /metadata\.interest is required/.test(error.error ?? '')),
      'Expected a per-item missing-interest error',
    );
    const feedRow = db.prepare('SELECT id FROM feed WHERE id = ?').get(itemId) as { id: string } | undefined;
    assert.equal(feedRow, undefined);
  });
  test('does not apply article body validation to non-article items', async () => {
    const sourceId = `analysis-title-body-match-${randomUUID()}`;
    const result = await submitItems([{
      id: `ma-${sourceId}`,
      type: 'analysis',
      source: 'evogent',
      sourceId,
      title: 'Internal synthesis',
      text: 'Internal synthesis',
      publishedAt: '2026-03-08T10:00:00.000Z',
      metadata: {},
    }]);

    assert.equal(result.status, 200);
    assert.equal(result.body.accepted, 1);
    assert.deepEqual(result.body.errors, []);
  });

  test('derives metadata.hnUrl from numeric sourceId when curator forgot to populate it', async () => {
    const sourceId = '48214449';
    const itemId = `ma-hn-derive-${randomUUID()}`;
    const result = await submitItems([{
      id: itemId,
      type: 'article',
      source: 'hackernews',
      sourceId,
      title: 'On Google declaring war on the Web',
      text: 'In Yesterday\'s IO Keynote Google declared war on the remnants of the Web. They are pushing Search more into the "here\'s your processed answer" direction that "AI Overviews" have established.',
      excerpt: 'In Yesterday\'s IO Keynote Google declared war on the remnants of the Web.',
      url: 'https://tante.cc/2026/05/20/on-google-declaring-war-on-the-web/',
      publishedAt: '2026-05-20T19:05:30.000Z',
      metadata: {},
    }]);

    assert.equal(result.status, 200);
    assert.equal(result.body.accepted, 1);

    const db = getDb();
    const row = db.prepare(`
      SELECT json_extract(metadata, '$.hnUrl') AS hnUrl
      FROM feed
      WHERE id = ?
    `).get(itemId) as { hnUrl: string | null } | undefined;
    assert.equal(row?.hnUrl, 'https://news.ycombinator.com/item?id=48214449');
  });

  test('derives metadata.hnUrl from hn-prefixed sourceId for items tagged via metadata.source=hackernews', async () => {
    const sourceId = `hn-48214500`;
    const itemId = `ma-hn-prefixed-${randomUUID()}`;
    const result = await submitItems([{
      id: itemId,
      type: 'article',
      source: 'web',
      sourceId,
      title: 'A prefixed HN derivation case',
      text: 'A new Hacker News surfaced article about web security best practices and the rise of formal verification in production systems built atop industrial controllers.',
      excerpt: 'A new Hacker News surfaced article about web security best practices.',
      url: 'https://example.com/',
      publishedAt: '2026-05-20T19:05:30.000Z',
      metadata: {
        source: 'hackernews',
      },
    }]);

    assert.equal(result.status, 200);
    assert.equal(result.body.accepted, 1);

    const db = getDb();
    const row = db.prepare(`
      SELECT json_extract(metadata, '$.hnUrl') AS hnUrl
      FROM feed
      WHERE id = ?
    `).get(itemId) as { hnUrl: string | null } | undefined;
    assert.equal(row?.hnUrl, 'https://news.ycombinator.com/item?id=48214500');
  });

  test('preserves an explicitly provided metadata.hnUrl for hackernews items', async () => {
    const sourceId = `48999999`;
    const itemId = `ma-hn-preserve-${randomUUID()}`;
    const explicitHnUrl = 'https://news.ycombinator.com/item?id=99999999';
    const result = await submitItems([{
      id: itemId,
      type: 'article',
      source: 'hackernews',
      sourceId,
      title: 'Custom HN article',
      text: 'A new Hacker News surfaced article about web security best practices and the rise of formal verification in production systems built atop industrial controllers.',
      excerpt: 'A new Hacker News surfaced article about web security best practices.',
      url: 'https://example.com/',
      publishedAt: '2026-05-20T19:05:30.000Z',
      metadata: {
        hnUrl: explicitHnUrl,
      },
    }]);

    assert.equal(result.status, 200);
    assert.equal(result.body.accepted, 1);

    const db = getDb();
    const row = db.prepare(`
      SELECT json_extract(metadata, '$.hnUrl') AS hnUrl
      FROM feed
      WHERE id = ?
    `).get(itemId) as { hnUrl: string | null } | undefined;
    assert.equal(row?.hnUrl, explicitHnUrl);
  });
});
