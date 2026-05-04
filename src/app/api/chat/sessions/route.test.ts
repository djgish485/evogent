import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { getChatSession } from '@/lib/db/chat-sessions';
import { POST } from './route';
import { PATCH } from './[sessionId]/route';

type GlobalWithDb = typeof globalThis & {
  evogentDb?: {
    close: () => void;
  };
};

const globalWithDb = globalThis as GlobalWithDb;
const originalFetch = global.fetch;

describe('chat session API codexFastMode', () => {
  let originalDbPath: string | undefined;
  let tempDir = '';

  beforeEach(async () => {
    originalDbPath = process.env.MEDIA_AGENT_DB_PATH;
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evogent-chat-session-api-test-'));

    if (globalWithDb.evogentDb) {
      globalWithDb.evogentDb.close();
      delete globalWithDb.evogentDb;
    }

    process.env.MEDIA_AGENT_DB_PATH = path.join(tempDir, 'media-agent.db');
    global.fetch = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });
  });

  afterEach(async () => {
    global.fetch = originalFetch;

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

  test('POST and PATCH accept and persist Codex xhigh reasoning and codexFastMode', async () => {
    const createResponse = await POST(new Request('http://127.0.0.1/api/chat/sessions', {
      method: 'POST',
      body: JSON.stringify({
        provider: 'codex',
        codexReasoningEffort: 'medium',
        codexFastMode: false,
        title: 'Codex Fast',
      }),
    }));
    const createPayload = await createResponse.json() as {
      session?: { id?: string; sessionId?: string; codexReasoningEffort?: string; codexFastMode?: boolean };
    };
    const sessionId = createPayload.session?.id ?? createPayload.session?.sessionId;

    assert.strictEqual(createResponse.status, 201);
    assert.strictEqual(typeof sessionId, 'string');
    assert.strictEqual(createPayload.session?.codexReasoningEffort, 'medium');
    assert.strictEqual(createPayload.session?.codexFastMode, false);
    assert.strictEqual(getChatSession(sessionId ?? '')?.codexReasoningEffort, 'medium');
    assert.strictEqual(getChatSession(sessionId ?? '')?.codexFastMode, false);

    const updateResponse = await PATCH(new Request(`http://127.0.0.1/api/chat/sessions/${sessionId}`, {
      method: 'PATCH',
      body: JSON.stringify({ codexReasoningEffort: 'xhigh', codexFastMode: true }),
    }), {
      params: Promise.resolve({ sessionId: sessionId ?? '' }),
    });
    const updatePayload = await updateResponse.json() as {
      session?: { codexReasoningEffort?: string; codexFastMode?: boolean };
    };

    assert.strictEqual(updateResponse.status, 200);
    assert.strictEqual(updatePayload.session?.codexReasoningEffort, 'xhigh');
    assert.strictEqual(updatePayload.session?.codexFastMode, true);
    assert.strictEqual(getChatSession(sessionId ?? '')?.codexReasoningEffort, 'xhigh');
    assert.strictEqual(getChatSession(sessionId ?? '')?.codexFastMode, true);
  });

  test('POST and PATCH reject non-boolean codexFastMode', async () => {
    const createResponse = await POST(new Request('http://127.0.0.1/api/chat/sessions', {
      method: 'POST',
      body: JSON.stringify({ provider: 'codex', codexFastMode: 'true' }),
    }));
    assert.strictEqual(createResponse.status, 400);

    const validResponse = await POST(new Request('http://127.0.0.1/api/chat/sessions', {
      method: 'POST',
      body: JSON.stringify({ provider: 'codex' }),
    }));
    const validPayload = await validResponse.json() as { session?: { id?: string; sessionId?: string } };
    const sessionId = validPayload.session?.id ?? validPayload.session?.sessionId ?? '';

    const updateResponse = await PATCH(new Request(`http://127.0.0.1/api/chat/sessions/${sessionId}`, {
      method: 'PATCH',
      body: JSON.stringify({ codexFastMode: 1 }),
    }), {
      params: Promise.resolve({ sessionId }),
    });
    assert.strictEqual(updateResponse.status, 400);
  });
});
