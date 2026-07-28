import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  CHAT_REPLY_PUSH_MAX_ATTEMPTS,
  CHAT_REPLY_PUSH_RECEIPT_RETENTION_MS,
  drainChatReplyPushOutbox,
  getChatReplyPushRetryDelayMs,
  recordChatReplyPushReceipt,
  resetChatReplyPushOutboxRuntimeForTests,
  waitForChatReplyPushOutboxIdleForTests,
} from '@/lib/chat-reply-push-outbox';
import { insertChatMessage } from '@/lib/db/chat';
import { createChatSession } from '@/lib/db/chat-sessions';
import { getDb } from '@/lib/db/client';
import type { PushNotificationsConfig } from '@/lib/push-notify';

type GlobalWithDb = typeof globalThis & {
  evogentDb?: {
    close: () => void;
  };
};

const globalWithDb = globalThis as GlobalWithDb;
const enabledConfig: PushNotificationsConfig = {
  enabled: true,
  provider: 'ntfy',
  ntfy: {
    server: 'https://ntfy.example.com',
    topic: 'outbox-test',
  },
  events: {
    chat_reply: {
      enabled: true,
      suppressWhenForeground: false,
    },
  },
};

describe('chat reply push outbox', { concurrency: false }, () => {
  let originalDbPath: string | undefined;
  let tempDir = '';

  beforeEach(async () => {
    originalDbPath = process.env.MEDIA_AGENT_DB_PATH;
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evogent-push-outbox-test-'));
    process.env.MEDIA_AGENT_DB_PATH = path.join(tempDir, 'media-agent.db');
    if (globalWithDb.evogentDb) {
      globalWithDb.evogentDb.close();
      delete globalWithDb.evogentDb;
    }
    resetChatReplyPushOutboxRuntimeForTests();
  });

  afterEach(async () => {
    await waitForChatReplyPushOutboxIdleForTests();
    resetChatReplyPushOutboxRuntimeForTests();
    if (globalWithDb.evogentDb) {
      globalWithDb.evogentDb.close();
      delete globalWithDb.evogentDb;
    }
    if (originalDbPath === undefined) {
      delete process.env.MEDIA_AGENT_DB_PATH;
    } else {
      process.env.MEDIA_AGENT_DB_PATH = originalDbPath;
    }
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  function insertAgentReply(id: string, text: string) {
    const session = createChatSession({
      id: randomUUID(),
      title: 'Push outbox test',
    });
    const message = insertChatMessage({
      id,
      type: 'chat',
      role: 'agent',
      sessionId: session.id,
      text,
      status: 'delivered',
    });
    assert.ok(message);
    return message;
  }

  test('a minimal receipt survives a database restart and drains from the chat row', async () => {
    const body = 'Durable reply text lives only in chat_messages';
    const message = insertAgentReply('chat-push-restart', body);
    const receipt = await recordChatReplyPushReceipt(message.id, {
      now: 10_000,
      readConfig: async () => enabledConfig,
    });
    assert.strictEqual(receipt.state, 'pending');

    const rawReceipt = getDb().prepare(`
      SELECT *
      FROM chat_reply_push_outbox
      WHERE message_id = ?
    `).get(message.id) as Record<string, unknown>;
    assert.doesNotMatch(JSON.stringify(rawReceipt), new RegExp(body));
    assert.doesNotMatch(JSON.stringify(rawReceipt), /ntfy\.example\.com|outbox-test/);
    assert.deepStrictEqual(
      getDb().prepare(`PRAGMA table_info(chat_reply_push_outbox)`)
        .all()
        .map((column) => (column as { name: string }).name)
        .filter((name) => /text|body|content/i.test(name)),
      [],
    );

    globalWithDb.evogentDb?.close();
    delete globalWithDb.evogentDb;

    const deliveredBodies: string[] = [];
    const drain = await drainChatReplyPushOutbox({
      now: () => 10_000,
      readConfig: async () => enabledConfig,
      getPresence: () => null,
      deliver: async (value) => {
        deliveredBodies.push(value);
        return true;
      },
    });

    assert.deepStrictEqual(deliveredBodies, [body]);
    assert.strictEqual(drain.delivered, 1);
    assert.deepStrictEqual(
      getDb().prepare(`
        SELECT state, attempt_count
        FROM chat_reply_push_outbox
        WHERE message_id = ?
      `).get(message.id),
      { state: 'delivered', attempt_count: 0 },
    );
  });

  test('failed delivery backs off exponentially, retries, and eventually succeeds', async () => {
    const message = insertAgentReply('chat-push-retry', 'Retry this reply');
    let now = 20_000;
    await recordChatReplyPushReceipt(message.id, {
      now,
      readConfig: async () => enabledConfig,
    });

    let attempts = 0;
    const first = await drainChatReplyPushOutbox({
      now: () => now,
      readConfig: async () => enabledConfig,
      getPresence: () => null,
      deliver: async () => {
        attempts += 1;
        return false;
      },
    });
    assert.strictEqual(first.retried, 1);
    assert.strictEqual(attempts, 1);

    const afterFailure = getDb().prepare(`
      SELECT state, attempt_count, next_attempt_at_ms
      FROM chat_reply_push_outbox
      WHERE message_id = ?
    `).get(message.id) as {
      state: string;
      attempt_count: number;
      next_attempt_at_ms: number;
    };
    assert.strictEqual(afterFailure.state, 'pending');
    assert.strictEqual(afterFailure.attempt_count, 1);
    assert.strictEqual(
      afterFailure.next_attempt_at_ms,
      now + getChatReplyPushRetryDelayMs(1),
    );

    await drainChatReplyPushOutbox({
      now: () => now,
      readConfig: async () => enabledConfig,
      getPresence: () => null,
      deliver: async () => {
        attempts += 1;
        return true;
      },
    });
    assert.strictEqual(attempts, 1, 'a retry must not run before next_attempt_at_ms');

    now = afterFailure.next_attempt_at_ms;
    const second = await drainChatReplyPushOutbox({
      now: () => now,
      readConfig: async () => enabledConfig,
      getPresence: () => null,
      deliver: async () => {
        attempts += 1;
        return true;
      },
    });
    assert.strictEqual(second.delivered, 1);
    assert.strictEqual(attempts, 2);
  });

  test('retry exhaustion and receipt retention are bounded', async () => {
    const message = insertAgentReply('chat-push-exhaustion', 'Bound retries');
    let now = 30_000;
    const receipt = await recordChatReplyPushReceipt(message.id, {
      now,
      readConfig: async () => enabledConfig,
    });
    const retryHorizonMs = Array.from(
      { length: CHAT_REPLY_PUSH_MAX_ATTEMPTS - 1 },
      (_, index) => getChatReplyPushRetryDelayMs(index + 1),
    ).reduce((total, delay) => total + delay, 0);
    assert.ok(retryHorizonMs >= 20 * 60 * 60 * 1_000);
    assert.ok(retryHorizonMs < 24 * 60 * 60 * 1_000);

    for (let attempt = 1; attempt <= CHAT_REPLY_PUSH_MAX_ATTEMPTS; attempt += 1) {
      await drainChatReplyPushOutbox({
        now: () => now,
        readConfig: async () => enabledConfig,
        getPresence: () => null,
        deliver: async () => false,
      });
      const row = getDb().prepare(`
        SELECT state, next_attempt_at_ms
        FROM chat_reply_push_outbox
        WHERE message_id = ?
      `).get(message.id) as { state: string; next_attempt_at_ms: number };
      if (row.state === 'pending') {
        now = row.next_attempt_at_ms;
      }
    }

    assert.deepStrictEqual(
      getDb().prepare(`
        SELECT state, terminal_reason, attempt_count
        FROM chat_reply_push_outbox
        WHERE message_id = ?
      `).get(message.id),
      {
        state: 'terminal',
        terminal_reason: 'retry_exhausted',
        attempt_count: CHAT_REPLY_PUSH_MAX_ATTEMPTS,
      },
    );

    await recordChatReplyPushReceipt('cleanup-trigger', {
      now: receipt.createdAtMs + CHAT_REPLY_PUSH_RECEIPT_RETENTION_MS + 1,
      readConfig: async () => null,
    });
    assert.strictEqual(
      getDb().prepare(`
        SELECT 1
        FROM chat_reply_push_outbox
        WHERE message_id = ?
      `).get(message.id),
      undefined,
    );
  });

  test('missing or disabled config and missing chat rows terminate without future sends', async () => {
    const absentConfigMessage = insertAgentReply('chat-push-no-config', 'Do not send later');
    const disabledConfigMessage = insertAgentReply('chat-push-disabled', 'Also do not send later');
    const absent = await recordChatReplyPushReceipt(absentConfigMessage.id, {
      now: 40_000,
      readConfig: async () => null,
    });
    const disabled = await recordChatReplyPushReceipt(disabledConfigMessage.id, {
      now: 40_000,
      readConfig: async () => ({
        ...enabledConfig,
        enabled: false,
      }),
    });
    assert.strictEqual(absent.state, 'terminal');
    assert.strictEqual(absent.terminalReason, 'config_unavailable');
    assert.strictEqual(disabled.state, 'terminal');

    await recordChatReplyPushReceipt('chat-push-missing-row', {
      now: 40_000,
      readConfig: async () => enabledConfig,
    });
    let deliveries = 0;
    const missingRowDrain = await drainChatReplyPushOutbox({
      now: () => 40_000,
      readConfig: async () => enabledConfig,
      getPresence: () => null,
      deliver: async () => {
        deliveries += 1;
        return true;
      },
    });
    assert.strictEqual(deliveries, 0);
    assert.strictEqual(missingRowDrain.terminal, 1);
    assert.deepStrictEqual(
      getDb().prepare(`
        SELECT state, terminal_reason
        FROM chat_reply_push_outbox
        WHERE message_id = 'chat-push-missing-row'
      `).get(),
      { state: 'terminal', terminal_reason: 'message_unavailable' },
    );

    const pendingMessage = insertAgentReply('chat-push-config-removed', 'Config disappeared');
    await recordChatReplyPushReceipt(pendingMessage.id, {
      now: 40_000,
      readConfig: async () => enabledConfig,
    });
    const removedConfigDrain = await drainChatReplyPushOutbox({
      now: () => 40_000,
      readConfig: async () => null,
      deliver: async () => {
        deliveries += 1;
        return true;
      },
    });
    assert.strictEqual(removedConfigDrain.terminal, 1);
    assert.strictEqual(deliveries, 0);
    assert.deepStrictEqual(
      getDb().prepare(`
        SELECT state, terminal_reason
        FROM chat_reply_push_outbox
        WHERE message_id = ?
      `).get(pendingMessage.id),
      { state: 'terminal', terminal_reason: 'config_unavailable' },
    );

    const changedDestinationMessage = insertAgentReply(
      'chat-push-destination-changed',
      'Do not reroute this reply',
    );
    await recordChatReplyPushReceipt(changedDestinationMessage.id, {
      now: 40_000,
      readConfig: async () => enabledConfig,
    });
    const changedDestinationDrain = await drainChatReplyPushOutbox({
      now: () => 40_000,
      readConfig: async () => ({
        ...enabledConfig,
        ntfy: {
          ...enabledConfig.ntfy,
          topic: 'replacement-destination',
        },
      }),
      getPresence: () => null,
      deliver: async () => {
        deliveries += 1;
        return true;
      },
    });
    assert.strictEqual(changedDestinationDrain.terminal, 1);
    assert.strictEqual(deliveries, 0);
    assert.deepStrictEqual(
      getDb().prepare(`
        SELECT state, terminal_reason
        FROM chat_reply_push_outbox
        WHERE message_id = ?
      `).get(changedDestinationMessage.id),
      { state: 'terminal', terminal_reason: 'config_changed' },
    );
  });

  test('ordered foreground presence suppresses a receipt without behavioral writes', async () => {
    const message = insertAgentReply('chat-push-foreground', 'Already visible');
    await recordChatReplyPushReceipt(message.id, {
      now: 50_000,
      readConfig: async () => enabledConfig,
    });
    let deliveries = 0;
    const drain = await drainChatReplyPushOutbox({
      now: () => 50_000,
      readConfig: async () => ({
        ...enabledConfig,
        events: {
          chat_reply: {
            enabled: true,
            suppressWhenForeground: true,
            suppressWindowSeconds: 120,
          },
        },
      }),
      getPresence: () => ({
        state: 'foreground',
        clientId: randomUUID(),
        lastSeenAt: new Date(50_000).toISOString(),
      }),
      deliver: async () => {
        deliveries += 1;
        return true;
      },
    });

    assert.strictEqual(drain.suppressed, 1);
    assert.strictEqual(deliveries, 0);
    assert.strictEqual(
      (getDb().prepare('SELECT COUNT(*) AS count FROM user_activity').get() as { count: number }).count,
      0,
    );
    assert.deepStrictEqual(
      getDb().prepare(`
        SELECT state, terminal_reason
        FROM chat_reply_push_outbox
        WHERE message_id = ?
      `).get(message.id),
      { state: 'suppressed', terminal_reason: 'foreground' },
    );
  });
});
