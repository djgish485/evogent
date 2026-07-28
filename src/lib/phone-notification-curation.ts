import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { notifyFeedUpdate } from '@/lib/curation-submit';
import {
  getFeedItemBySourceId,
  insertOrIgnoreFeedItem,
  updateFeedItemFields,
} from '@/lib/db/feed';
import { recordBrowseCacheRefresh } from '@/lib/db/browse-cache';
import { getDb } from '@/lib/db/client';
import { getDataPath } from '@/lib/data-dir';
import type { FeedItem, FeedMetadata } from '@/types/feed';

export type PhoneNotificationMode = 'observe' | 'curated' | 'paused';
export type PhoneNotificationLockScreenPreview = 'private' | 'detailed';

export interface PhoneNotificationSettings {
  schemaVersion: 1;
  mode: PhoneNotificationMode;
  lockScreenPreview: PhoneNotificationLockScreenPreview;
  preservedPackages: string[];
}

export interface PhoneNotificationSettingsState {
  config: PhoneNotificationSettings;
  state: 'default' | 'loaded' | 'invalid';
}

export interface ObservedNotificationApp {
  packageName: string;
  label: string;
  lastSeenAt: string;
  notificationCount: number;
  preserved: boolean;
}

export interface PhoneNotificationSettingsView extends PhoneNotificationSettingsState {
  observedApps: ObservedNotificationApp[];
  safeguards: {
    originalsAlwaysPreservedFor: string[];
    observeIsDefault: true;
    exactReceiptRequired: true;
    digestProofRequired: true;
  };
}

export interface PhoneNotificationIngestInput {
  schemaVersion: 1;
  eventId: string;
  packageName: string;
  appLabel: string | null;
  category: string | null;
  channelHash: string | null;
  flags: number;
  importance: number;
  clearable: boolean;
  ongoing: boolean;
  fullScreen: boolean;
  groupSummary: boolean;
  conversation: boolean;
  visibility: number;
  postedAtMs: number;
  historical: boolean;
  nativePriority: 'critical' | 'high' | 'normal' | 'low';
  nativeCanSuppress: boolean;
  nativeProtectionReason: string | null;
  contentRedacted: boolean;
  title: string | null;
  text: string | null;
  subText: string | null;
  digestCapability: boolean;
}

export interface PhoneNotificationIngestResult {
  ok: true;
  receipt: {
    eventId: string;
    sourceId: string | null;
    persisted: boolean;
  };
  policy: {
    mode: PhoneNotificationMode;
    suppressOriginal: boolean;
    preserveReason: string;
  };
  digest: {
    title: string;
    text: string;
    lockScreenPreview: PhoneNotificationLockScreenPreview;
  };
  feedItem: FeedItem | null;
}

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const MAX_POST_AGE_MS = 180 * 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

const CONTENT_SOURCE_BY_PACKAGE: Readonly<Record<string, string>> = Object.freeze({
  'com.google.android.gm': 'gmail',
  'com.google.android.apps.magazines': 'googlenews',
  'com.instagram.android': 'instagram',
  'com.reddit.frontpage': 'reddit',
  'com.linkedin.android': 'linkedin',
  'com.medium.reader': 'medium',
  'com.substack.app': 'substack',
  'flipboard.app': 'flipboard',
  'com.nytimes.android': 'nytimes',
});

const PROTECTED_CATEGORIES = new Set([
  'alarm',
  'call',
  'emergency',
  'navigation',
  'service',
  'transport',
  'system',
  'error',
  'location_sharing',
  'workout',
]);

const CRITICAL_SYSTEM_PACKAGES = new Set([
  'android',
  'com.android.systemui',
  'com.android.phone',
  'com.android.cellbroadcastreceiver',
  'com.google.android.cellbroadcastreceiver',
  'com.google.android.permissioncontroller',
  'com.google.android.apps.safetyhub',
  'com.google.android.safetycenter.resources',
]);

const SENSITIVE_PHRASES = [
  'verification code',
  'security code',
  'one-time code',
  'one time code',
  'one-time password',
  'one time password',
  'passcode',
  'auth code',
  '2fa code',
  'otp:',
  'password reset',
] as const;

const PROTECTED_LABELS = [
  'calls and alarms',
  'navigation and active services',
  'system and safety alerts',
  'high-importance or non-clearable notifications',
  'secret and one-time-code notifications',
  'notification group summaries',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizedText(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value
    .replace(/\0/g, ' ')
    .replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return null;
  return normalized.slice(0, maxChars);
}

function readBoolean(record: Record<string, unknown>, key: string): boolean {
  if (typeof record[key] !== 'boolean') {
    throw new Error(`Field "${key}" must be a boolean`);
  }
  return record[key];
}

function readFiniteInteger(
  record: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): number {
  const value = record[key];
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`Field "${key}" must be an integer from ${minimum} through ${maximum}`);
  }
  return Number(value);
}

function isPackageName(value: string): boolean {
  return value.length > 0
    && value.length <= 255
    && /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/.test(value);
}

function isLowerHex(value: string, length: number): boolean {
  return value.length === length && /^[0-9a-f]+$/.test(value);
}

function cloneDefaultSettings(): PhoneNotificationSettings {
  return {
    schemaVersion: 1,
    mode: 'observe',
    lockScreenPreview: 'private',
    preservedPackages: [],
  };
}

function settingsPath(): string {
  return getDataPath('phone-notification-curation.json');
}

function normalizeSettings(value: unknown): PhoneNotificationSettings | null {
  if (!isRecord(value) || value.schemaVersion !== 1) return null;
  const mode = value.mode;
  const lockScreenPreview = value.lockScreenPreview;
  if (mode !== 'observe' && mode !== 'curated' && mode !== 'paused') return null;
  if (lockScreenPreview !== 'private' && lockScreenPreview !== 'detailed') return null;
  if (!Array.isArray(value.preservedPackages)) return null;
  const preservedPackages = Array.from(new Set(value.preservedPackages.map((entry) => (
    typeof entry === 'string' ? entry.trim() : ''
  )))).filter(isPackageName).sort();
  if (preservedPackages.length !== value.preservedPackages.length || preservedPackages.length > 256) {
    return null;
  }
  return {
    schemaVersion: 1,
    mode,
    lockScreenPreview,
    preservedPackages,
  };
}

export async function readPhoneNotificationSettings(): Promise<PhoneNotificationSettingsState> {
  const filePath = settingsPath();
  try {
    const stat = await fs.promises.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return { config: cloneDefaultSettings(), state: 'invalid' };
    }
    const parsed = JSON.parse(await fs.promises.readFile(filePath, 'utf8')) as unknown;
    const config = normalizeSettings(parsed);
    return config
      ? { config, state: 'loaded' }
      : { config: cloneDefaultSettings(), state: 'invalid' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { config: cloneDefaultSettings(), state: 'default' };
    }
    return { config: cloneDefaultSettings(), state: 'invalid' };
  }
}

async function persistPhoneNotificationSettings(config: PhoneNotificationSettings): Promise<void> {
  const filePath = settingsPath();
  const directory = path.dirname(filePath);
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const stat = await fs.promises.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('Notification settings path is not a regular file');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(
      temporaryPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      0o600,
    );
    await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(temporaryPath, filePath);
    await fs.promises.chmod(filePath, 0o600);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await fs.promises.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export async function updatePhoneNotificationSettings(
  patch: unknown,
): Promise<PhoneNotificationSettingsState> {
  if (!isRecord(patch)) throw new Error('Invalid notification settings payload');
  const current = await readPhoneNotificationSettings();
  let mode = current.config.mode;
  let lockScreenPreview = current.config.lockScreenPreview;
  let preservedPackages = current.config.preservedPackages;

  if ('mode' in patch) {
    if (patch.mode !== 'observe' && patch.mode !== 'curated' && patch.mode !== 'paused') {
      throw new Error('mode must be observe, curated, or paused');
    }
    if (
      patch.mode === 'curated'
      && current.config.mode !== 'curated'
      && patch.confirmCurated !== true
    ) {
      throw new Error('Enabling curated mode requires explicit confirmation');
    }
    mode = patch.mode;
  }
  if ('lockScreenPreview' in patch) {
    if (patch.lockScreenPreview !== 'private' && patch.lockScreenPreview !== 'detailed') {
      throw new Error('lockScreenPreview must be private or detailed');
    }
    lockScreenPreview = patch.lockScreenPreview;
  }
  if ('preservedPackages' in patch) {
    if (!Array.isArray(patch.preservedPackages) || patch.preservedPackages.length > 256) {
      throw new Error('preservedPackages must be an array with at most 256 entries');
    }
    preservedPackages = Array.from(new Set(patch.preservedPackages.map((entry) => {
      if (typeof entry !== 'string' || !isPackageName(entry.trim())) {
        throw new Error('preservedPackages contains an invalid package name');
      }
      return entry.trim();
    }))).sort();
  }

  const config: PhoneNotificationSettings = {
    schemaVersion: 1,
    mode,
    lockScreenPreview,
    preservedPackages,
  };
  await persistPhoneNotificationSettings(config);
  return { config, state: 'loaded' };
}

export function parsePhoneNotificationIngestInput(
  value: unknown,
  now = Date.now(),
): PhoneNotificationIngestInput {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error('Unsupported phone notification schema');
  }
  const eventId = normalizedText(value.eventId, 64) ?? '';
  if (!isLowerHex(eventId, 64)) throw new Error('eventId must be 64 lowercase hex characters');
  const packageName = normalizedText(value.packageName, 255) ?? '';
  if (!isPackageName(packageName)) throw new Error('Invalid packageName');
  const postedAtMs = readFiniteInteger(
    value,
    'postedAtMs',
    Math.max(0, now - MAX_POST_AGE_MS),
    now + MAX_FUTURE_SKEW_MS,
  );
  const nativePriority = value.nativePriority;
  if (
    nativePriority !== 'critical'
    && nativePriority !== 'high'
    && nativePriority !== 'normal'
    && nativePriority !== 'low'
  ) {
    throw new Error('Invalid nativePriority');
  }

  const contentRedacted = readBoolean(value, 'contentRedacted');
  return {
    schemaVersion: 1,
    eventId,
    packageName,
    appLabel: normalizedText(value.appLabel, 120),
    category: normalizedText(value.category, 80)?.toLowerCase() ?? null,
    channelHash: (() => {
      const channelHash = normalizedText(value.channelHash, 64);
      if (channelHash && !isLowerHex(channelHash, 64)) {
        throw new Error('channelHash must be 64 lowercase hex characters');
      }
      return channelHash;
    })(),
    flags: readFiniteInteger(value, 'flags', 0, 0x7fffffff),
    importance: readFiniteInteger(value, 'importance', -1000, 5),
    clearable: readBoolean(value, 'clearable'),
    ongoing: readBoolean(value, 'ongoing'),
    fullScreen: readBoolean(value, 'fullScreen'),
    groupSummary: readBoolean(value, 'groupSummary'),
    conversation: readBoolean(value, 'conversation'),
    visibility: readFiniteInteger(value, 'visibility', -1, 1),
    postedAtMs,
    historical: readBoolean(value, 'historical'),
    nativePriority,
    nativeCanSuppress: readBoolean(value, 'nativeCanSuppress'),
    nativeProtectionReason: normalizedText(value.nativeProtectionReason, 80),
    contentRedacted,
    title: contentRedacted ? null : normalizedText(value.title, 512),
    text: contentRedacted ? null : normalizedText(value.text, 4096),
    subText: contentRedacted ? null : normalizedText(value.subText, 512),
    digestCapability: readBoolean(value, 'digestCapability'),
  };
}

interface ServerClassification {
  contentRedacted: boolean;
  priority: 'critical' | 'high' | 'normal' | 'low';
  protectedFromSuppression: boolean;
  protectionReason: string | null;
}

function containsSensitivePhrase(input: PhoneNotificationIngestInput): boolean {
  const combined = [input.title, input.text, input.subText]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return SENSITIVE_PHRASES.some((phrase) => combined.includes(phrase));
}

export function classifyPhoneNotification(
  input: PhoneNotificationIngestInput,
): ServerClassification {
  const category = input.category ?? '';
  let protectionReason: string | null = null;
  if (input.packageName === 'net.dangish.evogent') protectionReason = 'self';
  else if (input.fullScreen) protectionReason = 'full_screen';
  else if (input.groupSummary) protectionReason = 'group_summary';
  else if (input.ongoing || (input.flags & 0x00000002) !== 0) protectionReason = 'ongoing';
  else if ((input.flags & 0x00000040) !== 0) protectionReason = 'foreground_service';
  else if ((input.flags & 0x00000004) !== 0) protectionReason = 'insistent';
  else if (!input.clearable) protectionReason = 'non_clearable';
  else if (input.importance === -1000) protectionReason = 'ranking_unavailable';
  else if (input.importance >= 4) protectionReason = 'high_importance';
  else if (CRITICAL_SYSTEM_PACKAGES.has(input.packageName)) protectionReason = 'system_safety';
  else if (PROTECTED_CATEGORIES.has(category)) protectionReason = 'protected_category';

  const contentRedacted = input.contentRedacted
    || input.visibility === -1
    || protectionReason === 'system_safety'
    || containsSensitivePhrase(input);
  if (contentRedacted && !protectionReason) protectionReason = 'sensitive_content';

  let priority: ServerClassification['priority'] = input.nativePriority;
  if (
    input.fullScreen
    || category === 'call'
    || category === 'alarm'
    || category === 'emergency'
    || category === 'error'
    || protectionReason === 'system_safety'
  ) {
    priority = 'critical';
  } else if (
    input.importance >= 4
    || input.conversation
    || category === 'message'
    || category === 'email'
    || category === 'missed_call'
    || category === 'reminder'
    || category === 'event'
  ) {
    priority = 'high';
  }

  return {
    contentRedacted,
    priority,
    protectedFromSuppression: Boolean(protectionReason),
    protectionReason,
  };
}

function notificationSummary(
  input: PhoneNotificationIngestInput,
  classification: ServerClassification,
): { title: string; text: string; appLabel: string } {
  const packageFallback = input.packageName.split('.').pop() || 'App';
  const appLabel = input.appLabel ?? packageFallback;
  if (classification.contentRedacted) {
    return {
      appLabel,
      title: `${appLabel} · protected`,
      text: 'A sensitive or safety-related notification was preserved in Android; its contents were not stored by Evogent.',
    };
  }
  const title = input.title ?? appLabel;
  const body = input.text ?? input.subText ?? 'A new notification arrived.';
  const text = input.subText && input.subText !== body
    ? `${body} — ${input.subText}`
    : body;
  return {
    appLabel,
    title: title === appLabel ? appLabel : `${appLabel} · ${title}`,
    text: text.slice(0, 1200),
  };
}

function dedupeSourceId(
  input: PhoneNotificationIngestInput,
  classification: ServerClassification,
): string {
  const bucket = Math.floor(input.postedAtMs / SIX_HOURS_MS);
  const digest = createHash('sha256')
    .update(JSON.stringify([
      input.packageName,
      input.category,
      input.channelHash,
      classification.contentRedacted ? '[redacted]' : input.title,
      classification.contentRedacted ? '[redacted]' : input.text,
      classification.contentRedacted ? '[redacted]' : input.subText,
      bucket,
    ]))
    .digest('hex');
  return `phone-notification:${digest}`;
}

function parseOccurrenceCount(item: FeedItem | null): number {
  const count = item?.metadata?.occurrences;
  return typeof count === 'number' && Number.isFinite(count)
    ? Math.max(1, Math.floor(count))
    : 1;
}

function persistNotificationFeedItem(
  input: PhoneNotificationIngestInput,
  classification: ServerClassification,
  config: PhoneNotificationSettings,
  preserveReason: string,
): { sourceId: string; item: FeedItem | null } {
  const sourceId = dedupeSourceId(input, classification);
  const summary = notificationSummary(input, classification);
  const existing = getFeedItemBySourceId(sourceId);
  const occurrences = existing ? parseOccurrenceCount(existing) + 1 : 1;
  const publishedAt = new Date(input.postedAtMs).toISOString();
  const expiresAt = new Date(
    input.postedAtMs + (classification.priority === 'critical' || classification.priority === 'high'
      ? 7 * 24 * 60 * 60 * 1000
      : 3 * 24 * 60 * 60 * 1000),
  ).toISOString();
  const metadata: FeedMetadata = {
    notificationId: sourceId,
    phoneNotification: true,
    severity: classification.priority === 'critical' ? 'warning' : 'info',
    dismissable: true,
    phonePriority: classification.priority,
    appPackage: input.packageName,
    appLabel: summary.appLabel,
    contentRedacted: classification.contentRedacted,
    protectedFromSuppression: classification.protectedFromSuppression,
    protectionReason: classification.protectionReason,
    requestedDisposition: preserveReason === 'eligible_for_curated_digest'
      ? 'curated_digest'
      : 'preserve_original',
    curationMode: config.mode,
    occurrences,
    firstPostedAt: existing?.metadata?.firstPostedAt ?? publishedAt,
    lastPostedAt: publishedAt,
    lastReceiptEventId: input.eventId,
    expiresAt,
  };

  if (existing) {
    return {
      sourceId,
      item: updateFeedItemFields(existing.id, {
        title: summary.title,
        text: summary.text,
        published_at: publishedAt,
        metadata,
      }),
    };
  }

  insertOrIgnoreFeedItem({
    id: randomUUID(),
    type: 'notification',
    source: 'phone-notification',
    sourceId,
    title: summary.title,
    text: summary.text,
    reason: 'Lightweight on-device notification curation',
    tags: ['phone', 'notification', classification.priority],
    metadata,
    publishedAt,
  });
  return { sourceId, item: getFeedItemBySourceId(sourceId) };
}

function recordContentSourceSignal(
  input: PhoneNotificationIngestInput,
  classification: ServerClassification,
  sourceId: string,
): void {
  const source = CONTENT_SOURCE_BY_PACKAGE[input.packageName];
  if (
    !source
    || classification.contentRedacted
    || input.conversation
    || input.category === 'message'
    || input.category === 'call'
  ) {
    return;
  }
  const now = Date.now();
  try {
    recordBrowseCacheRefresh({
      source,
      triggeredBy: 'phone-notification-listener',
      startedAtMs: now,
      completedAtMs: now,
      status: 'completed',
      itemsAdded: 1,
      items: [{
        source,
        sourceId: `notif-${sourceId.slice('phone-notification:'.length)}`,
        title: input.title,
        publishedAtMs: input.postedAtMs,
        payload: {
          type: 'notification-signal',
          title: input.title,
          text: input.text,
          subText: input.subText,
          postedAtMs: input.postedAtMs,
          captureMethod: 'phone-notification-listener',
        },
        fetchedAtMs: now,
        expiresAtMs: now + 3 * 24 * 60 * 60 * 1000,
      }],
    });
  } catch {
    // Feed persistence is the cancellation receipt. Optional source-refresh hints must never turn
    // a successful local curation receipt into a false failure.
  }
}

function resolvePreserveReason(
  input: PhoneNotificationIngestInput,
  classification: ServerClassification,
  config: PhoneNotificationSettings,
): string {
  if (config.mode === 'paused') return 'curation_paused';
  if (config.mode !== 'curated') return 'observe_mode';
  if (input.historical) return 'historical_scan';
  if (config.preservedPackages.includes(input.packageName)) return 'app_preserved';
  if (classification.protectedFromSuppression) {
    return classification.protectionReason ?? 'protected';
  }
  if (!input.nativeCanSuppress) return 'native_ineligible';
  if (!input.digestCapability) return 'digest_unavailable';
  return 'eligible_for_curated_digest';
}

export async function ingestPhoneNotification(
  input: PhoneNotificationIngestInput,
): Promise<PhoneNotificationIngestResult> {
  const settingsState = await readPhoneNotificationSettings();
  const config = settingsState.config;
  const classification = classifyPhoneNotification(input);
  const preserveReason = resolvePreserveReason(input, classification, config);
  const summary = notificationSummary(input, classification);

  if (input.packageName === 'net.dangish.evogent' || config.mode === 'paused') {
    return {
      ok: true,
      receipt: { eventId: input.eventId, sourceId: null, persisted: false },
      policy: { mode: config.mode, suppressOriginal: false, preserveReason },
      digest: {
        title: 'Evogent',
        text: 'Notification curation is paused.',
        lockScreenPreview: config.lockScreenPreview,
      },
      feedItem: null,
    };
  }

  const persisted = persistNotificationFeedItem(
    input,
    classification,
    config,
    preserveReason,
  );
  if (persisted.item) {
    recordContentSourceSignal(input, classification, persisted.sourceId);
  }
  const suppressOriginal = Boolean(
    persisted.item && preserveReason === 'eligible_for_curated_digest',
  );
  return {
    ok: true,
    receipt: {
      eventId: input.eventId,
      sourceId: persisted.sourceId,
      persisted: Boolean(persisted.item),
    },
    policy: {
      mode: config.mode,
      suppressOriginal,
      preserveReason: persisted.item ? preserveReason : 'persistence_failed',
    },
    digest: {
      title: 'Evogent',
      text: `${summary.appLabel}: ${summary.text}`.slice(0, 512),
      lockScreenPreview: config.lockScreenPreview,
    },
    feedItem: persisted.item,
  };
}

export async function ingestAndNotifyPhoneNotification(
  input: PhoneNotificationIngestInput,
): Promise<PhoneNotificationIngestResult> {
  const result = await ingestPhoneNotification(input);
  if (result.feedItem) {
    await notifyFeedUpdate([result.feedItem]);
  }
  return result;
}

function observedNotificationApps(config: PhoneNotificationSettings): ObservedNotificationApp[] {
  const rows = getDb().prepare(`
    SELECT metadata, created_at_ms
    FROM feed
    WHERE type = 'notification'
      AND source = 'phone-notification'
      AND metadata IS NOT NULL
    ORDER BY created_at_ms DESC
  `).all() as Array<{ metadata: string; created_at_ms: number | null }>;
  const byPackage = new Map<string, ObservedNotificationApp>();
  for (const row of rows) {
    let metadata: Record<string, unknown>;
    try {
      const parsed = JSON.parse(row.metadata) as unknown;
      if (!isRecord(parsed) || parsed.phoneNotification !== true) continue;
      metadata = parsed;
    } catch {
      continue;
    }
    const packageName = normalizedText(metadata.appPackage, 255);
    if (!packageName || !isPackageName(packageName)) continue;
    const label = normalizedText(metadata.appLabel, 120) ?? packageName;
    const createdAt = Number.isFinite(row.created_at_ms)
      ? Number(row.created_at_ms)
      : Date.now();
    const existing = byPackage.get(packageName);
    if (existing) {
      existing.notificationCount += 1;
      continue;
    }
    byPackage.set(packageName, {
      packageName,
      label,
      lastSeenAt: new Date(createdAt).toISOString(),
      notificationCount: 1,
      preserved: config.preservedPackages.includes(packageName),
    });
  }
  return [...byPackage.values()].sort((a, b) => (
    Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt)
  ));
}

export async function getPhoneNotificationSettingsView(): Promise<PhoneNotificationSettingsView> {
  const state = await readPhoneNotificationSettings();
  return {
    ...state,
    observedApps: observedNotificationApps(state.config),
    safeguards: {
      originalsAlwaysPreservedFor: [...PROTECTED_LABELS],
      observeIsDefault: true,
      exactReceiptRequired: true,
      digestProofRequired: true,
    },
  };
}
