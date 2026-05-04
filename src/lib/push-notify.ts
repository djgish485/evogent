import fs from 'node:fs';
import { getDataPath } from '@/lib/data-dir';
import type { UserActivityRecord } from '@/lib/db/activity';

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
    suppressWindowSeconds: toPositiveInt(eventConfig.suppressWindowSeconds, 120),
  };
}

export function shouldSuppressPushNotification(
  activity: UserActivityRecord | null,
  eventConfig: PushNotificationEventConfig | null,
  now = Date.now(),
): boolean {
  if (!eventConfig?.enabled || !eventConfig.suppressWhenForeground || activity?.event !== 'foreground') {
    return false;
  }

  const activityTime = Date.parse(activity.timestamp);
  if (!Number.isFinite(activityTime) || activityTime > now) {
    return false;
  }

  return now - activityTime <= eventConfig.suppressWindowSeconds * 1000;
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
  const body = message.trim();
  if (!body) return false;

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
  });

  if (!response.ok) {
    console.warn(`[push-notify] ntfy request failed for ${eventType}: ${response.status}`);
  }

  return response.ok;
}
