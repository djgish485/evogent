import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { invalidateSkillActionRegistryForTests } from '@/lib/feed-actions/skill-action-registry';
import { POST } from './route';

type GlobalWithDb = typeof globalThis & {
  evogentDb?: {
    close: () => void;
  };
};

const globalWithDb = globalThis as GlobalWithDb;

const originalFetch = globalThis.fetch;
const originalInternalBaseUrl = process.env.MEDIA_AGENT_INTERNAL_BASE_URL;
const originalSkillsDir = process.env.MEDIA_AGENT_SKILLS_DIR;
const originalDbPath = process.env.MEDIA_AGENT_DB_PATH;
const originalDataDir = process.env.DATA_DIR;
const originalPath = process.env.PATH;
let tempDir = '';

async function writeEmailTriageSkill(skillsRoot: string) {
  const skillDir = path.join(skillsRoot, 'email-triage');
  await fs.promises.mkdir(skillDir, { recursive: true });
  await fs.promises.writeFile(path.join(skillDir, 'SKILL.md'), `---
name: email-triage
description: Triage important inbox updates
metadata:
  evogent:
    feed-actions:
      - id: triage-all
        label: Triage all
        confirms: false
---
# Email Triage
`, 'utf8');
}

describe('/api/feed-actions', () => {
  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evogent-feed-action-route-test-'));

    if (globalWithDb.evogentDb) {
      globalWithDb.evogentDb.close();
      delete globalWithDb.evogentDb;
    }

    process.env.MEDIA_AGENT_DB_PATH = path.join(tempDir, 'media-agent.db');
    process.env.DATA_DIR = tempDir;
    const binDir = path.join(tempDir, 'bin');
    await fs.promises.mkdir(binDir, { recursive: true });
    await fs.promises.writeFile(path.join(binDir, 'claude'), '#!/usr/bin/env sh\necho claude-test\n', { mode: 0o755 });
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    if (originalInternalBaseUrl === undefined) {
      delete process.env.MEDIA_AGENT_INTERNAL_BASE_URL;
    } else {
      process.env.MEDIA_AGENT_INTERNAL_BASE_URL = originalInternalBaseUrl;
    }
    if (originalSkillsDir === undefined) {
      delete process.env.MEDIA_AGENT_SKILLS_DIR;
    } else {
      process.env.MEDIA_AGENT_SKILLS_DIR = originalSkillsDir;
    }
    invalidateSkillActionRegistryForTests();

    if (globalWithDb.evogentDb) {
      globalWithDb.evogentDb.close();
      delete globalWithDb.evogentDb;
    }

    if (originalDbPath === undefined) {
      delete process.env.MEDIA_AGENT_DB_PATH;
    } else {
      process.env.MEDIA_AGENT_DB_PATH = originalDbPath;
    }
    if (originalDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = originalDataDir;
    }
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }

    if (tempDir) {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  test('dispatches a declared skill action directly into the Curator Agent chat session', async () => {
    const skillsRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evogent-feed-action-route-'));
    process.env.MEDIA_AGENT_SKILLS_DIR = skillsRoot;
    invalidateSkillActionRegistryForTests();

    let capturedUrl = '';
    let capturedBody: Record<string, unknown> | null = null;
    globalThis.fetch = async (url, init) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
      return Response.json({
        ok: true,
        requestId: String((capturedBody as Record<string, unknown>)?.requestId ?? ''),
        priority: 'user_chat',
        queueDepth: 1,
        position: 1,
        acceptedAt: new Date().toISOString(),
      }, { status: 202 });
    };

    try {
      await writeEmailTriageSkill(skillsRoot);
      const response = await POST(new Request('http://127.0.0.1/api/feed-actions', {
        method: 'POST',
        body: JSON.stringify({
          actionId: 'email-triage.triage-all',
          feedItemId: 'email-card-1',
          payload: { selection: { senderDomain: 'example.com' } },
        }),
      }));
      const result = await response.json() as Record<string, unknown>;

      assert.equal(response.status, 202);
      assert.equal(result.ok, true);
      assert.equal(typeof result.runId, 'string');
      assert.match(String(result.runId), /^feed-action-/);
      assert.equal(typeof result.sessionId, 'string');
      assert.ok(String(result.sessionId).length > 0);
      assert.ok(capturedUrl.endsWith('/api/orchestrator/enqueue'));
      assert.match(String(capturedBody?.message), /Action: email-triage\.triage-all on feed item email-card-1/);
      assert.match(String(capturedBody?.message), /Payload JSON: \{"selection":\{"senderDomain":"example\.com"\}\}/);
      assert.equal(typeof capturedBody?.requestId, 'string');
      assert.equal(capturedBody?.requestId, result.runId);
    } finally {
      await fs.promises.rm(skillsRoot, { recursive: true, force: true });
    }
  });

  test('rejects undeclared skill actions without dispatching', async () => {
    let calledFetch = false;
    globalThis.fetch = async () => {
      calledFetch = true;
      return Response.json({ ok: true });
    };

    const response = await POST(new Request('http://127.0.0.1/api/feed-actions', {
      method: 'POST',
      body: JSON.stringify({
        actionId: 'missing.action',
        feedItemId: 'card-1',
        payload: {},
      }),
    }));
    const result = await response.json() as { error?: string };

    assert.equal(response.status, 400);
    assert.match(result.error || '', /No installed skill declares feed action "missing\.action"/);
    assert.equal(calledFetch, false);
  });
});
