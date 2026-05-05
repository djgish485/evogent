import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, describe, test } from 'node:test';

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
