import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  getPushNotificationEventConfig,
  PUSH_NOTIFICATION_BODY_MAX_BYTES,
  PUSH_NOTIFICATION_MIN_FOREGROUND_SUPPRESS_WINDOW_SECONDS,
  PUSH_NOTIFICATION_REQUEST_TIMEOUT_MS,
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

    let request!: { url: string; init: RequestInit };
    const ok = await sendPushNotification('chat_reply', 'Reply is ready', {
      fetchImpl: async (url, init) => {
        request = { url: String(url), init: init ?? {} };
        return new Response(null, { status: 200 });
      },
    });

    assert.strictEqual(ok, true);
    assert.strictEqual(request.url, 'https://ntfy.example.com/evogent-test');
    assert.deepStrictEqual(request.init.headers, {
      'Content-Type': 'text/plain; charset=utf-8',
      Title: 'Agent reply ready',
      Priority: '4',
      Tags: 'chat,reply',
    });
    assert.strictEqual(request.init.method, 'POST');
    assert.strictEqual(request.init.body, 'Reply is ready');
    assert.ok(request.init.signal instanceof AbortSignal);
    assert.strictEqual(request.init.signal.aborted, false);
    assert.strictEqual(PUSH_NOTIFICATION_REQUEST_TIMEOUT_MS, 5_000);
  });
});

test('sendPushNotification bounds long UTF-8 notification bodies without splitting characters', async () => {
  const config: PushNotificationsConfig = {
    enabled: true,
    provider: 'ntfy',
    ntfy: {
      topic: 'bounded-body',
      server: 'https://ntfy.example.com',
    },
    events: {
      chat_reply: {
        enabled: true,
      },
    },
  };
  let requestBody = '';

  const ok = await sendPushNotification('chat_reply', `  ${'🙂'.repeat(200)}  `, {
    config,
    fetchImpl: async (_url, init) => {
      requestBody = typeof init?.body === 'string' ? init.body : '';
      return new Response(null, { status: 200 });
    },
  });

  assert.strictEqual(ok, true);
  assert.ok(Buffer.byteLength(requestBody, 'utf8') <= PUSH_NOTIFICATION_BODY_MAX_BYTES);
  assert.ok(requestBody.endsWith('…'));
  assert.doesNotMatch(requestBody, /\uFFFD/);
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

test('getPushNotificationEventConfig keeps presence fresh between low-frequency heartbeats', () => {
  const tooShort = getPushNotificationEventConfig({
    enabled: true,
    events: {
      chat_reply: {
        enabled: true,
        suppressWindowSeconds: 30,
      },
    },
  }, 'chat_reply');
  const longer = getPushNotificationEventConfig({
    enabled: true,
    events: {
      chat_reply: {
        enabled: true,
        suppressWindowSeconds: 300,
      },
    },
  }, 'chat_reply');

  assert.strictEqual(
    tooShort?.suppressWindowSeconds,
    PUSH_NOTIFICATION_MIN_FOREGROUND_SUPPRESS_WINDOW_SECONDS,
  );
  assert.strictEqual(longer?.suppressWindowSeconds, 300);
});

test('shouldSuppressPushNotification follows the dedicated foreground-presence lease', () => {
  const now = Date.parse('2026-04-11T10:00:00.000Z');
  const eventConfig = {
    enabled: true,
    title: null,
    suppressWhenForeground: true,
    suppressWindowSeconds: 120,
  };

  assert.strictEqual(shouldSuppressPushNotification({
    state: 'foreground',
    clientId: 'visible-page',
    lastSeenAt: '2026-04-11T09:58:30.000Z',
  }, eventConfig, now), true);

  assert.strictEqual(shouldSuppressPushNotification({
    state: 'background',
    clientId: 'hidden-page',
    lastSeenAt: '2026-04-11T09:58:30.000Z',
  }, eventConfig, now), false);

  assert.strictEqual(shouldSuppressPushNotification({
    state: 'foreground',
    clientId: 'stale-page',
    lastSeenAt: '2026-04-11T09:57:00.000Z',
  }, eventConfig, now), false);

  assert.strictEqual(shouldSuppressPushNotification({
    state: 'foreground',
    clientId: 'future-page',
    lastSeenAt: '2026-04-11T10:00:01.000Z',
  }, eventConfig, now), false);
});
