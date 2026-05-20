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

  test('deduplicates OpenClaw skill submissions by bundle dir when sourceId changes', async () => {
    const bundleDir = path.join(tempDir, 'skill-runs', 'competitor-watch');
    const outputPath = path.join(bundleDir, 'output.md');
    const firstSourceId = `competitor-watch-${randomUUID()}`;
    const secondSourceId = `evogent-skill:competitor-watch:${Math.floor(Date.now() / 1000)}`;
    const metadata = {
      mcpAppHtml: '<article>Competitor watch output</article>',
      openClaw: {
        bundleDir,
        skill: 'competitor-watch',
        outputPath,
      },
    };

    const firstResult = await submitItems([{
      id: `ma-openclaw-skill-first-${randomUUID()}`,
      type: 'notification',
      source: 'openclaw',
      sourceId: firstSourceId,
      title: 'Competitor watch',
      text: 'First rendering of the same OpenClaw skill output.',
      publishedAt: '2026-03-08T10:00:00.000Z',
      metadata,
    }]);

    assert.equal(firstResult.status, 200);
    assert.equal(firstResult.body.accepted, 1);
    assert.equal(firstResult.body.duplicates, 0);

    const secondResult = await submitItems([{
      id: `ma-openclaw-skill-second-${randomUUID()}`,
      type: 'notification',
      source: 'openclaw',
      sourceId: secondSourceId,
      title: 'Competitor watch again',
      text: 'Second rendering should dedupe even though the sourceId changed.',
      publishedAt: '2026-03-08T10:05:00.000Z',
      metadata,
    }]);

    assert.equal(secondResult.status, 200);
    assert.equal(secondResult.body.accepted, 0);
    assert.equal(secondResult.body.duplicates, 1);
    assert.deepEqual(secondResult.body.duplicateSourceIds, [`openclaw-bundle:${bundleDir}`]);
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
      url: `https://example.com/articles/${sourceId}`,
      publishedAt: '2026-03-08T10:00:00.000Z',
      metadata: {},
    }]);

    assert.equal(result.status, 200);
    assert.equal(result.body.accepted, 1);
    assert.deepEqual(result.body.errors, []);
    assert.equal(result.body.acceptedIds?.length, 1);
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
});
