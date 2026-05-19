import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { invalidateSkillActionRegistryForTests } from '@/lib/feed-actions/skill-action-registry';
import { POST } from './route';

const originalFetch = globalThis.fetch;
const originalInternalBaseUrl = process.env.MEDIA_AGENT_INTERNAL_BASE_URL;
const originalSkillsDir = process.env.MEDIA_AGENT_SKILLS_DIR;

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
  afterEach(() => {
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
  });

  test('dispatches a declared skill action through the OpenClaw skill session', async () => {
    const skillsRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evogent-feed-action-route-'));
    process.env.MEDIA_AGENT_SKILLS_DIR = skillsRoot;
    process.env.MEDIA_AGENT_INTERNAL_BASE_URL = 'http://127.0.0.1:3999';
    invalidateSkillActionRegistryForTests();

    let capturedUrl = '';
    let capturedBody: Record<string, unknown> | null = null;
    globalThis.fetch = async (url, init) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
      return Response.json({
        ok: true,
        sessionId: 'openclaw:agent:email-triage:main',
        runId: 'run-feed-action',
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
      assert.equal(result.runId, 'run-feed-action');
      assert.equal(capturedUrl, 'http://127.0.0.1:3999/api/openclaw/chat/agent%3Aemail-triage%3Amain');
      assert.match(String(capturedBody?.message), /Action: email-triage\.triage-all on feed item email-card-1/);
      assert.match(String(capturedBody?.message), /Payload JSON: \{"selection":\{"senderDomain":"example\.com"\}\}/);
      assert.equal(typeof capturedBody?.idempotencyKey, 'string');
    } finally {
      await fs.promises.rm(skillsRoot, { recursive: true, force: true });
    }
  });

  test('rejects undeclared skill actions without calling OpenClaw', async () => {
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
