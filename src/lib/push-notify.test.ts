import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  getPushNotificationEventConfig,
  readPushNotificationConfig,
  sendPushNotification,
  shouldSuppressPushNotification,
  type PushNotificationsConfig,
} from '@/lib/push-notify';

async function withTempDataDir<T>(fn: (dataDir: string) => Promise<T>): Promise<T> {
  const originalDataDir = process.env.DATA_DIR;
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evogent-push-notify-'));
  process.env.DATA_DIR = dataDir;

  try {
    return await fn(dataDir);
  } finally {
    if (originalDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = originalDataDir;
    }
    await fs.promises.rm(dataDir, { recursive: true, force: true });
  }
}

test('readPushNotificationConfig returns null when config file is missing', async () => {
  await withTempDataDir(async () => {
    assert.strictEqual(await readPushNotificationConfig(), null);
  });
});

test('sendPushNotification posts enabled events to ntfy', async () => {
  await withTempDataDir(async (dataDir) => {
    const config: PushNotificationsConfig = {
      enabled: true,
      provider: 'ntfy',
      ntfy: {
        topic: 'evogent-test',
        server: 'https://ntfy.example.com/',
        priority: 4,
        tags: ['chat', 'reply'],
      },
      events: {
        chat_reply: {
          enabled: true,
          title: 'Agent reply ready',
        },
      },
    };
    await fs.promises.writeFile(
      path.join(dataDir, 'push-notifications.json'),
      `${JSON.stringify(config, null, 2)}\n`,
      'utf8',
    );

    let request: { url: string; init: RequestInit } | null = null;
    const ok = await sendPushNotification('chat_reply', 'Reply is ready', {
      fetchImpl: async (url, init) => {
        request = { url: String(url), init: init ?? {} };
        return new Response(null, { status: 200 });
      },
    });

    assert.strictEqual(ok, true);
    assert.deepStrictEqual(request, {
      url: 'https://ntfy.example.com/evogent-test',
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          Title: 'Agent reply ready',
          Priority: '4',
          Tags: 'chat,reply',
        },
        body: 'Reply is ready',
      },
    });
  });
});

test('getPushNotificationEventConfig applies the default suppress window', () => {
  const eventConfig = getPushNotificationEventConfig({
    enabled: true,
    events: {
      chat_reply: {
        enabled: true,
      },
    },
  }, 'chat_reply');

  assert.deepStrictEqual(eventConfig, {
    enabled: true,
    title: null,
    suppressWhenForeground: true,
    suppressWindowSeconds: 120,
  });
});

test('shouldSuppressPushNotification only suppresses recent foreground activity', () => {
  const now = Date.parse('2026-04-11T10:00:00.000Z');
  const eventConfig = {
    enabled: true,
    title: null,
    suppressWhenForeground: true,
    suppressWindowSeconds: 120,
  };

  assert.strictEqual(shouldSuppressPushNotification({
    id: 1,
    event: 'foreground',
    timestamp: '2026-04-11T09:58:30.000Z',
    metadata: null,
  }, eventConfig, now), true);

  assert.strictEqual(shouldSuppressPushNotification({
    id: 2,
    event: 'background',
    timestamp: '2026-04-11T09:58:30.000Z',
    metadata: null,
  }, eventConfig, now), false);

  assert.strictEqual(shouldSuppressPushNotification({
    id: 3,
    event: 'foreground',
    timestamp: '2026-04-11T09:57:00.000Z',
    metadata: null,
  }, eventConfig, now), false);
});
