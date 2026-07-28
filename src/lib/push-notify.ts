import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import { getDataPath } from '@/lib/data-dir';
import type { AppPresenceRecord } from '@/lib/db/presence';

export const PUSH_NOTIFICATION_BODY_MAX_BYTES = 512;
export const PUSH_NOTIFICATION_REQUEST_TIMEOUT_MS = 5_000;
// Background reports clear presence immediately. This window only protects
// against a missed lifecycle signal, so keep enough margin above the 75-second
// visible heartbeat rather than increasing phone wakeups/writes.
export const PUSH_NOTIFICATION_MIN_FOREGROUND_SUPPRESS_WINDOW_SECONDS = 120;

export interface PushNotificationEventConfig {
  enabled: boolean;
  title: string | null;
  suppressWhenForeground: boolean;
  suppressWindowSeconds: number;
}

export interface PushNotificationsConfig {
  enabled?: boolean;
  provider?: string;
  ntfy?: {
    topic?: string;
    server?: string;
    priority?: string | number;
    tags?: string[];
  };
  events?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function toPositiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function boundNotificationBody(value: string): string {
  const characters: string[] = [];
  const byteLengths: number[] = [];
  let totalBytes = 0;

  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (totalBytes + characterBytes > PUSH_NOTIFICATION_BODY_MAX_BYTES) {
      const suffix = '…';
      const suffixBytes = Buffer.byteLength(suffix, 'utf8');
      while (
        byteLengths.length > 0
        && totalBytes > PUSH_NOTIFICATION_BODY_MAX_BYTES - suffixBytes
      ) {
        totalBytes -= byteLengths.pop() ?? 0;
        characters.pop();
      }
      return `${characters.join('').trimEnd()}${suffix}`;
    }
    characters.push(character);
    byteLengths.push(characterBytes);
    totalBytes += characterBytes;
  }

  return value;
}

export async function readPushNotificationConfig(): Promise<PushNotificationsConfig | null> {
  try {
    const raw = await fs.promises.readFile(getDataPath('push-notifications.json'), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed as PushNotificationsConfig : null;
  } catch {
    return null;
  }
}

export function getPushNotificationEventConfig(
  config: PushNotificationsConfig | null,
  eventType: string,
): PushNotificationEventConfig | null {
  if (!config?.enabled || !isRecord(config.events)) return null;
  const eventConfig = config.events[eventType];
  if (!isRecord(eventConfig) || eventConfig.enabled === false) return null;

  return {
    enabled: true,
    title: typeof eventConfig.title === 'string' && eventConfig.title.trim() ? eventConfig.title.trim() : null,
    suppressWhenForeground: eventConfig.suppressWhenForeground !== false,
    suppressWindowSeconds: Math.max(
      toPositiveInt(
        eventConfig.suppressWindowSeconds,
        PUSH_NOTIFICATION_MIN_FOREGROUND_SUPPRESS_WINDOW_SECONDS,
      ),
      PUSH_NOTIFICATION_MIN_FOREGROUND_SUPPRESS_WINDOW_SECONDS,
    ),
  };
}

export function shouldSuppressPushNotification(
  presence: AppPresenceRecord | null,
  eventConfig: PushNotificationEventConfig | null,
  now = Date.now(),
): boolean {
  if (
    !eventConfig?.enabled
    || !eventConfig.suppressWhenForeground
    || presence?.state !== 'foreground'
  ) {
    return false;
  }

  const lastSeenAt = Date.parse(presence.lastSeenAt);
  if (!Number.isFinite(lastSeenAt) || lastSeenAt > now) {
    return false;
  }

  return now - lastSeenAt <= eventConfig.suppressWindowSeconds * 1000;
}

export async function sendPushNotification(
  eventType: string,
  message: string,
  options: {
    config?: PushNotificationsConfig | null;
    title?: string | null;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<boolean> {
  const trimmedBody = message.trim();
  if (!trimmedBody) return false;
  const body = boundNotificationBody(trimmedBody);

  const config = options.config ?? await readPushNotificationConfig();
  const eventConfig = getPushNotificationEventConfig(config, eventType);
  if (!eventConfig || config?.provider !== 'ntfy') return false;

  const topic = typeof config.ntfy?.topic === 'string' ? config.ntfy.topic.trim() : '';
  if (!topic) return false;

  const server = typeof config.ntfy?.server === 'string' && config.ntfy.server.trim()
    ? config.ntfy.server.trim().replace(/\/+$/, '')
    : 'https://ntfy.sh';
  const title = options.title?.trim() || eventConfig.title;
  const tags = Array.isArray(config.ntfy?.tags)
    ? config.ntfy.tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0)
    : [];

  const response = await (options.fetchImpl ?? fetch)(`${server}/${encodeURIComponent(topic)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      ...(title ? { Title: title } : {}),
      ...(config.ntfy?.priority != null ? { Priority: String(config.ntfy.priority) } : {}),
      ...(tags.length > 0 ? { Tags: tags.join(',') } : {}),
    },
    body,
    signal: AbortSignal.timeout(PUSH_NOTIFICATION_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    console.warn(`[push-notify] ntfy request failed for ${eventType}: ${response.status}`);
  }

  return response.ok;
}
