import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { notifyFeedUpdate } from '@/lib/curation-submit';
import {
  getFeedItemById,
  getFeedItemBySourceId,
  insertOrIgnoreFeedItem,
  setFeedItemSuggestionStatus,
  updateFeedItemFields,
} from '@/lib/db/feed';
import { getDb } from '@/lib/db/client';
import { getDataPath } from '@/lib/data-dir';
import { signalSourceDue } from '@/lib/source-due-signal';
import type { FeedItem, FeedMetadata } from '@/types/feed';

export type PhoneNotificationMode = 'observe' | 'curated' | 'paused';
export type PhoneNotificationLockScreenPreview = 'private' | 'detailed';
export type PhoneNotificationReplacementScope = 'per_app' | 'all_eligible';

export interface PhoneNotificationSettings {
  schemaVersion: 1;
  mode: PhoneNotificationMode;
  lockScreenPreview: PhoneNotificationLockScreenPreview;
  replacementScope: PhoneNotificationReplacementScope;
  preservedPackages: string[];
  replacementPackages: string[];
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
  replacementAllowed: boolean;
}

export interface PhoneNotificationSettingsView extends PhoneNotificationSettingsState {
  observedApps: ObservedNotificationApp[];
  safeguards: {
    originalsAlwaysPreservedFor: string[];
    observeIsDefault: true;
    originalsPreservedByDefault: true;
    replacementScopeIsExplicit: true;
    preservedPackagesOverrideScope: true;
    keyOnlyCancellationIsBestEffort: true;
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
  nativeCategoryWireExact: boolean;
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
    replacementAllowed: boolean;
    suppressOriginal: boolean;
    preserveReason: string;
  };
  digest: {
    title: string;
    text: string;
    lockScreenPreview: PhoneNotificationLockScreenPreview;
    activeCount: number;
    coveredEventIds: string[];
    expiresAtMs: number | null;
  };
  feedItem: FeedItem | null;
}

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const MAX_POST_AGE_MS = 180 * 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const NOTIFICATION_TOMBSTONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_DIGEST_COVERED_EVENTS = 32;
export const PHONE_NOTIFICATION_NATIVE_END_TO_END_BUDGET_MS = 2000;
export const PHONE_NOTIFICATION_AUTHORITY_REVOCATION_DRAIN_MS =
  PHONE_NOTIFICATION_NATIVE_END_TO_END_BUDGET_MS + 1;
const PHONE_NOTIFICATION_SETTINGS_LOCK_KEY = Symbol.for(
  'evogent.phone-notification-settings-lock.v1',
);

type PhoneNotificationSettingsLockState = {
  tail: Promise<void>;
};

export interface PhoneNotificationRevocationBarrierOptions {
  monotonicNow?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
}

function getPhoneNotificationSettingsLockState(): PhoneNotificationSettingsLockState {
  const processGlobal = globalThis as Record<PropertyKey, unknown>;
  const existing = processGlobal[PHONE_NOTIFICATION_SETTINGS_LOCK_KEY];
  if (existing && typeof existing === 'object' && 'tail' in existing) {
    return existing as PhoneNotificationSettingsLockState;
  }

  const state: PhoneNotificationSettingsLockState = {
    tail: Promise.resolve(),
  };
  processGlobal[PHONE_NOTIFICATION_SETTINGS_LOCK_KEY] = state;
  return state;
}

async function withPhoneNotificationSettingsLock<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const state = getPhoneNotificationSettingsLockState();
  let release!: () => void;
  const predecessor = state.tail;
  state.tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await predecessor;

  try {
    return await operation();
  } finally {
    release();
  }
}

const CONTENT_SOURCE_BY_PACKAGE: Readonly<Record<string, string>> = Object.freeze({
  'com.google.android.gm': 'gmail',
  'com.google.android.apps.magazines': 'googlenews',
  'com.google.android.youtube': 'youtube',
  'com.instagram.android': 'instagram',
  'com.reddit.frontpage': 'reddit',
  'com.twitter.android': 'twitter',
  'com.linkedin.android': 'linkedin',
  'com.medium.reader': 'medium',
  'com.substack.app': 'substack-app',
  'flipboard.app': 'flipboard',
  'com.nytimes.android': 'nytimes',
});

// Android's Notification.CATEGORY_* values are wire literals, not their Java
// constant names: for example SYSTEM is "sys", ERROR is "err", and MESSAGE is
// "msg". Replacement is intentionally allowlisted. A missing, vendor-defined,
// newly added, communication, authentication, or safety category remains
// Android-owned even if an older native client reports nativeCanSuppress=true.
const REPLACEMENT_ELIGIBLE_CATEGORIES = new Set([
  'promo',
  'recommendation',
  'social',
]);

const CRITICAL_CATEGORIES = new Set([
  'alarm',
  'call',
  'car_emergency',
  'car_warning',
  'emergency',
  'err',
  'error',
  'navigation',
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
    replacementScope: 'per_app',
    preservedPackages: [],
    replacementPackages: [],
  };
}

function settingsPath(): string {
  return getDataPath('phone-notification-curation.json');
}

function normalizeSettings(value: unknown): PhoneNotificationSettings | null {
  if (!isRecord(value) || value.schemaVersion !== 1) return null;
  const mode = value.mode;
  const lockScreenPreview = value.lockScreenPreview;
  // replacementScope was added to schema one after the original per-package release. Missing
  // values migrate to the narrower behavior; broad low-stakes replacement is never inferred.
  const replacementScope = value.replacementScope ?? 'per_app';
  if (mode !== 'observe' && mode !== 'curated' && mode !== 'paused') return null;
  if (lockScreenPreview !== 'private' && lockScreenPreview !== 'detailed') return null;
  if (replacementScope !== 'per_app' && replacementScope !== 'all_eligible') return null;
  if (!Array.isArray(value.preservedPackages)) return null;
  // schemaVersion 1 predates explicit per-package replacement. Missing means the
  // safe migrated default: preserve every Android original.
  const rawReplacementPackages = value.replacementPackages ?? [];
  if (!Array.isArray(rawReplacementPackages)) return null;
  const preservedPackages = Array.from(new Set(value.preservedPackages.map((entry) => (
    typeof entry === 'string' ? entry.trim() : ''
  )))).filter(isPackageName).sort();
  const replacementPackages = Array.from(new Set(rawReplacementPackages.map((entry) => (
    typeof entry === 'string' ? entry.trim() : ''
  )))).filter(isPackageName).sort();
  if (preservedPackages.length !== value.preservedPackages.length || preservedPackages.length > 256) {
    return null;
  }
  if (
    replacementPackages.length !== rawReplacementPackages.length
    || replacementPackages.length > 256
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    mode,
    lockScreenPreview,
    replacementScope,
    preservedPackages,
    replacementPackages,
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
    fs.fsyncSync(handle.fd);
    await handle.close();
    handle = null;
    await fs.promises.rename(temporaryPath, filePath);
    await fs.promises.chmod(filePath, 0o600);

    // A successful revocation response is an authority boundary: prove both
    // the renamed inode (including its final mode) and directory entry reached
    // stable storage before returning it to the caller.
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    const finalDescriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    try {
      fs.fsyncSync(finalDescriptor);
    } finally {
      fs.closeSync(finalDescriptor);
    }
    const directoryDescriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(directoryDescriptor);
    } finally {
      fs.closeSync(directoryDescriptor);
    }
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await fs.promises.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export function didPhoneNotificationReplacementAuthorityDecrease(
  previous: PhoneNotificationSettings,
  next: PhoneNotificationSettings,
): boolean {
  if (previous.mode !== 'curated') return false;

  const previouslyAllowedPackages = previous.replacementPackages.filter(
    (packageName) => !previous.preservedPackages.includes(packageName),
  );
  const previousHadAuthority = previous.replacementScope === 'all_eligible'
    || previouslyAllowedPackages.length > 0;
  if (!previousHadAuthority) return false;
  if (next.mode !== 'curated') return true;

  if (previous.replacementScope === 'all_eligible') {
    if (next.replacementScope !== 'all_eligible') return true;
    return next.preservedPackages.some(
      (packageName) => !previous.preservedPackages.includes(packageName),
    );
  }

  return previouslyAllowedPackages.some((packageName) => (
    next.preservedPackages.includes(packageName)
    || (
      next.replacementScope !== 'all_eligible'
      && !next.replacementPackages.includes(packageName)
    )
  ));
}

export async function waitForPhoneNotificationAuthorityRevocationDrain(
  authorityDecreased: boolean,
  options: PhoneNotificationRevocationBarrierOptions = {},
): Promise<void> {
  if (!authorityDecreased) return;

  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const sleep = options.sleep ?? ((delayMs: number) => (
    new Promise<void>((resolve) => setTimeout(resolve, delayMs))
  ));
  const deadline = monotonicNow() + PHONE_NOTIFICATION_AUTHORITY_REVOCATION_DRAIN_MS;

  while (true) {
    const remainingMs = deadline - monotonicNow();
    if (remainingMs <= 0) return;
    await sleep(Math.max(1, Math.ceil(remainingMs)));
  }
}

export async function updatePhoneNotificationSettings(
  patch: unknown,
  barrierOptions: PhoneNotificationRevocationBarrierOptions = {},
): Promise<PhoneNotificationSettingsState> {
  if (!isRecord(patch)) throw new Error('Invalid notification settings payload');
  let authorityDecreased = false;
  const state = await withPhoneNotificationSettingsLock(async () => {
    // Reading and validating authority additions must be in the same critical
    // section as the final durable rename. Otherwise an unrelated concurrent
    // PATCH can merge from stale bytes and resurrect a completed revocation.
    const current = await readPhoneNotificationSettings();
    let mode = current.config.mode;
    let lockScreenPreview = current.config.lockScreenPreview;
    let replacementScope = current.config.replacementScope;
    let preservedPackages = current.config.preservedPackages;
    let replacementPackages = current.config.replacementPackages;

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
    if ('replacementScope' in patch) {
      if (patch.replacementScope !== 'per_app' && patch.replacementScope !== 'all_eligible') {
        throw new Error('replacementScope must be per_app or all_eligible');
      }
      if (
        patch.replacementScope === 'all_eligible'
        && current.config.replacementScope !== 'all_eligible'
        && patch.confirmBestEffortReplacement !== true
      ) {
        throw new Error(
          'Replacing every eligible low-stakes original requires explicit best-effort confirmation',
        );
      }
      replacementScope = patch.replacementScope;
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
    if ('replacementPackages' in patch) {
      if (!Array.isArray(patch.replacementPackages) || patch.replacementPackages.length > 256) {
        throw new Error('replacementPackages must be an array with at most 256 entries');
      }
      const nextReplacementPackages = Array.from(new Set(patch.replacementPackages.map((entry) => {
        if (typeof entry !== 'string' || !isPackageName(entry.trim())) {
          throw new Error('replacementPackages contains an invalid package name');
        }
        return entry.trim();
      }))).sort();
      const existing = new Set(replacementPackages);
      const addsReplacementAuthority = nextReplacementPackages.some((entry) => !existing.has(entry));
      if (addsReplacementAuthority && patch.confirmBestEffortReplacement !== true) {
        throw new Error(
          'Allowing Android-original replacement requires explicit best-effort confirmation',
        );
      }
      replacementPackages = nextReplacementPackages;
    }

    const config: PhoneNotificationSettings = {
      schemaVersion: 1,
      mode,
      lockScreenPreview,
      replacementScope,
      preservedPackages,
      replacementPackages,
    };
    authorityDecreased = didPhoneNotificationReplacementAuthorityDecrease(
      current.config,
      config,
    );
    await persistPhoneNotificationSettings(config);
    return { config, state: 'loaded' as const };
  });
  // A native ingest that read the old file started its single end-to-end deadline before this
  // durable rename. Do not acknowledge reduced authority until that entire cancellation window
  // has elapsed. Additions and unrelated settings changes return immediately.
  await waitForPhoneNotificationAuthorityRevocationDrain(
    authorityDecreased,
    barrierOptions,
  );
  return state;
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
  const category = normalizedText(value.category, 80);
  const nativeCategoryWireExact = readBoolean(value, 'nativeCategoryWireExact')
    && typeof value.category === 'string'
    && value.category === category;
  return {
    schemaVersion: 1,
    eventId,
    packageName,
    appLabel: normalizedText(value.appLabel, 120),
    // Android category values are exact lowercase wire literals. The trusted native client also
    // supplies its pre-normalization decision; missing/false clients fail closed below.
    category,
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
    nativeCategoryWireExact,
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
  else if (input.nativeProtectionReason) protectionReason = 'native_protected';
  else if (input.fullScreen) protectionReason = 'full_screen';
  else if (input.groupSummary) protectionReason = 'group_summary';
  else if (input.conversation) protectionReason = 'conversation';
  else if (input.ongoing || (input.flags & 0x00000002) !== 0) protectionReason = 'ongoing';
  else if ((input.flags & 0x00000040) !== 0) protectionReason = 'foreground_service';
  else if ((input.flags & 0x00000004) !== 0) protectionReason = 'insistent';
  else if (!input.clearable) protectionReason = 'non_clearable';
  else if (input.importance === -1000) protectionReason = 'ranking_unavailable';
  else if (input.importance >= 4) protectionReason = 'high_importance';
  else if (CRITICAL_SYSTEM_PACKAGES.has(input.packageName)) protectionReason = 'system_safety';
  else if (
    !input.nativeCategoryWireExact
    || !REPLACEMENT_ELIGIBLE_CATEGORIES.has(category)
  ) {
    protectionReason = category ? 'protected_category' : 'category_unavailable';
  }

  const contentRedacted = input.contentRedacted
    || input.visibility === -1
    || protectionReason === 'system_safety'
    || containsSensitivePhrase(input);
  if (contentRedacted && !protectionReason) protectionReason = 'sensitive_content';

  let priority: ServerClassification['priority'] = input.nativePriority;
  if (
    input.fullScreen
    || CRITICAL_CATEGORIES.has(category)
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

function isReplacementAllowedForPackage(
  config: PhoneNotificationSettings,
  packageName: string,
): boolean {
  return !config.preservedPackages.includes(packageName)
    && (
      config.replacementScope === 'all_eligible'
      || config.replacementPackages.includes(packageName)
    );
}

function prunePhoneNotificationTombstones(now = Date.now()): void {
  getDb().prepare(`
    DELETE FROM phone_notification_tombstones
    WHERE removed_at_ms < ?
  `).run(now - NOTIFICATION_TOMBSTONE_RETENTION_MS);
}

function isPhoneNotificationEventTombstoned(eventId: string): boolean {
  const row = getDb().prepare(`
    SELECT 1 AS present
    FROM phone_notification_tombstones
    WHERE event_id = ?
    LIMIT 1
  `).get(eventId) as { present: number } | undefined;
  return Boolean(row?.present);
}

function persistNotificationFeedItem(
  input: PhoneNotificationIngestInput,
  classification: ServerClassification,
  config: PhoneNotificationSettings,
  preserveReason: string,
): {
  sourceId: string;
  item: FeedItem | null;
  tombstoned: boolean;
  suppressionIdentityOwned: boolean;
  suppressionIdentityNewlyCurated: boolean;
} {
  const sourceId = dedupeSourceId(input, classification);
  prunePhoneNotificationTombstones();
  if (isPhoneNotificationEventTombstoned(input.eventId)) {
    return {
      sourceId,
      item: null,
      tombstoned: true,
      suppressionIdentityOwned: false,
      suppressionIdentityNewlyCurated: false,
    };
  }
  const summary = notificationSummary(input, classification);
  const existing = getFeedItemBySourceId(sourceId);
  // A duplicate inside the six-hour bucket must not revive a row the user dismissed or Android
  // removed. We intentionally do not mint an exact receipt for this new event: without one the
  // native side preserves its Android original and cannot publish a replacement digest.
  if (
    existing?.suggestionStatus === 'dismissed'
    || typeof existing?.metadata?.phoneNotificationRemovedAt === 'string'
  ) {
    return {
      sourceId,
      item: null,
      tombstoned: true,
      suppressionIdentityOwned: false,
      suppressionIdentityNewlyCurated: false,
    };
  }
  const publishedAt = new Date(input.postedAtMs).toISOString();
  const expiresAt = new Date(
    input.postedAtMs + (classification.priority === 'critical' || classification.priority === 'high'
      ? 7 * 24 * 60 * 60 * 1000
      : 3 * 24 * 60 * 60 * 1000),
  ).toISOString();
  const requestedDisposition = preserveReason === 'eligible_for_curated_digest'
    ? 'curated_digest'
    : 'preserve_original';
  const incomingMetadata: FeedMetadata = {
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
    requestedDisposition,
    curationMode: config.mode,
    occurrences: 1,
    firstPostedAt: publishedAt,
    lastPostedAt: publishedAt,
    lastReceiptEventId: input.eventId,
    expiresAt,
  };

  if (existing) {
    const existingOwner = normalizedText(existing.metadata?.lastReceiptEventId, 64);
    const existingOwnerIsValid = Boolean(
      existingOwner && isLowerHex(existingOwner, 64),
    );
    const sameExactEvent = existingOwnerIsValid && existingOwner === input.eventId;
    const existingDisposition = existing.metadata?.requestedDisposition === 'curated_digest'
      ? 'curated_digest'
      : 'preserve_original';
    const existingHasCuratedOwner = existingOwnerIsValid
      && existingDisposition === 'curated_digest';
    const existingLastPostedAt = Date.parse(
      normalizedText(existing.metadata?.lastPostedAt, 80) ?? existing.publishedAt,
    );
    const incomingIsNewer = !Number.isFinite(existingLastPostedAt)
      || input.postedAtMs > existingLastPostedAt;

    // Native can publish the server response and then fail before cancellation, so the server can
    // never infer which response currently owns Android's fixed digest notification. Once a
    // dedupe bucket has a curated owner, keep that exact event identity and disposition immutable.
    // Later occurrences remain useful local evidence but stay in Android and cannot replace the
    // owner. For never-curated rows, only a strictly newer event may advance ownership; LIFO worker
    // completion therefore cannot regress the UI/native dismissal identity to an older callback.
    const adoptIncomingOwner = !existingOwnerIsValid
      || sameExactEvent
      || (!existingHasCuratedOwner && incomingIsNewer);
    const preserveExistingOwnership = existingOwnerIsValid
      && (!adoptIncomingOwner || existingHasCuratedOwner);
    const existingExpiry = Date.parse(
      normalizedText(existing.metadata?.expiresAt, 80) ?? '',
    );
    const nextExpiry = Number.isFinite(existingExpiry)
      && existingExpiry > Date.parse(expiresAt)
      ? new Date(existingExpiry).toISOString()
      : expiresAt;
    const existingLastPosted = normalizedText(existing.metadata?.lastPostedAt, 80)
      ?? existing.publishedAt;
    const occurrences = sameExactEvent
      ? parseOccurrenceCount(existing)
      : parseOccurrenceCount(existing) + 1;
    const metadata: FeedMetadata = {
      ...incomingMetadata,
      occurrences,
      firstPostedAt: existing.metadata?.firstPostedAt ?? existing.publishedAt,
      lastPostedAt: incomingIsNewer ? publishedAt : existingLastPosted,
      expiresAt: nextExpiry,
      ...(!incomingIsNewer ? {
        appLabel: existing.metadata?.appLabel,
        severity: existing.metadata?.severity,
      } : {}),
      ...(preserveExistingOwnership ? {
        phonePriority: existing.metadata?.phonePriority,
        contentRedacted: existing.metadata?.contentRedacted,
        protectedFromSuppression: existing.metadata?.protectedFromSuppression,
        protectionReason: existing.metadata?.protectionReason,
        requestedDisposition: existingDisposition,
        curationMode: existing.metadata?.curationMode,
        lastReceiptEventId: existingOwner,
      } : {}),
    };
    const updated = incomingIsNewer
      ? updateFeedItemFields(existing.id, {
          title: summary.title,
          text: summary.text,
          published_at: publishedAt,
          metadata,
        })
      : updateFeedItemFields(existing.id, { metadata });
    return {
      sourceId,
      item: updated,
      tombstoned: false,
      suppressionIdentityOwned: (
        preserveExistingOwnership ? existingOwner : input.eventId
      ) === input.eventId,
      suppressionIdentityNewlyCurated: !existingHasCuratedOwner
        && adoptIncomingOwner
        && requestedDisposition === 'curated_digest',
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
    metadata: incomingMetadata,
    publishedAt,
  });
  return {
    sourceId,
    item: getFeedItemBySourceId(sourceId),
    tombstoned: false,
    suppressionIdentityOwned: true,
    suppressionIdentityNewlyCurated: requestedDisposition === 'curated_digest',
  };
}

function buildPhoneNotificationDigest(
  config: PhoneNotificationSettings,
): PhoneNotificationIngestResult['digest'] {
  const now = Date.now();
  const rows = getDb().prepare(`
    SELECT
      json_extract(metadata, '$.lastReceiptEventId') AS event_id,
      json_extract(metadata, '$.appLabel') AS app_label,
      json_extract(metadata, '$.expiresAt') AS expires_at,
      title AS item_title,
      COUNT(*) OVER () AS total_count
    FROM feed
    WHERE type = 'notification'
      AND source = 'phone-notification'
      AND metadata IS NOT NULL
      AND COALESCE(json_extract(metadata, '$.suggestionStatus'), 'pending') != 'dismissed'
      AND json_extract(metadata, '$.requestedDisposition') = 'curated_digest'
      AND COALESCE(json_extract(metadata, '$.protectedFromSuppression'), 1) = 0
      AND LENGTH(json_extract(metadata, '$.lastReceiptEventId')) = 64
      AND json_extract(metadata, '$.lastReceiptEventId') NOT GLOB '*[^0-9a-f]*'
      AND json_type(metadata, '$.expiresAt') = 'text'
      AND CAST(strftime('%s', json_extract(metadata, '$.expiresAt')) AS INTEGER) * 1000 > ?
    ORDER BY
      CASE json_extract(metadata, '$.phonePriority')
        WHEN 'critical' THEN 0
        WHEN 'high' THEN 1
        WHEN 'normal' THEN 2
        WHEN 'low' THEN 3
        ELSE 4
      END ASC,
      COALESCE(published_at_ms, created_at_ms, 0) DESC,
      id ASC
    LIMIT ?
  `).all(
    now,
    MAX_DIGEST_COVERED_EVENTS,
  ) as Array<{
    event_id: string;
    app_label: string | null;
    expires_at: string;
    item_title: string | null;
    total_count: number;
  }>;
  const coveredEventIds = rows.map((row) => row.event_id);
  // Android must be able to retract every unit represented by activeCount using the bounded
  // coverage list alone. The server UI still retains every row; the native digest deliberately
  // represents only this fully owned, ranked window.
  const activeCount = coveredEventIds.length;
  const hasMore = Math.max(0, Math.floor(rows[0]?.total_count ?? 0)) > activeCount;
  const expiresAtMs = rows.reduce(
    (earliest, row) => Math.min(earliest, Date.parse(row.expires_at)),
    Number.POSITIVE_INFINITY,
  );
  if (
    activeCount === 0
    || coveredEventIds.length === 0
    || !Number.isSafeInteger(expiresAtMs)
    || expiresAtMs <= now
  ) {
    return {
      title: 'Evogent',
      text: 'Curated notifications are ready.',
      lockScreenPreview: config.lockScreenPreview,
      activeCount: 0,
      coveredEventIds: [],
      expiresAtMs: null,
    };
  }

  const top = rows.slice(0, 3).map((row) => {
    const label = normalizedText(row.app_label, 120)
      ?? normalizedText(row.item_title, 120)
      ?? 'App';
    return label;
  });
  const remaining = Math.max(0, activeCount - top.length);
  return {
    title: hasMore
      ? `${activeCount} recent curated notifications`
      : activeCount === 1
      ? '1 curated notification'
      : `${activeCount} curated notifications`,
    text: `${top.join(' · ')}${
      hasMore
        ? ' · more in Evogent'
        : remaining > 0
          ? ` · +${remaining} more`
          : ''
    }`.slice(0, 512),
    lockScreenPreview: config.lockScreenPreview,
    activeCount,
    coveredEventIds,
    expiresAtMs,
  };
}

function recordContentSourceDueSignal(
  input: PhoneNotificationIngestInput,
  classification: ServerClassification,
): void {
  const source = CONTENT_SOURCE_BY_PACKAGE[input.packageName];
  if (
    !source
    || input.historical
    || classification.contentRedacted
    || input.conversation
    || input.category === 'msg'
    || input.category === 'call'
  ) {
    return;
  }
  try {
    signalSourceDue(source);
  } catch {
    // Feed persistence is the cancellation receipt. An optional content-free due signal must
    // never turn successful local notification curation into a false failure.
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
  if (!isReplacementAllowedForPackage(config, input.packageName)) {
    return 'app_not_replacement_allowed';
  }
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
  const replacementAllowed = isReplacementAllowedForPackage(config, input.packageName);

  if (input.packageName === 'net.dangish.evogent' || config.mode === 'paused') {
    return {
      ok: true,
      receipt: { eventId: input.eventId, sourceId: null, persisted: false },
      policy: {
        mode: config.mode,
        replacementAllowed,
        suppressOriginal: false,
        preserveReason,
      },
      digest: {
        title: 'Evogent',
        text: 'Notification curation is paused.',
        lockScreenPreview: config.lockScreenPreview,
        activeCount: 0,
        coveredEventIds: [],
        expiresAtMs: null,
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
    recordContentSourceDueSignal(input, classification);
  }
  let digest = buildPhoneNotificationDigest(config);
  let digestCoversInput = digest.coveredEventIds.includes(input.eventId);
  const capacityDemoted = Boolean(
    persisted.item
      && preserveReason === 'eligible_for_curated_digest'
      && persisted.suppressionIdentityOwned
      && persisted.suppressionIdentityNewlyCurated
      && !digestCoversInput,
  );
  if (capacityDemoted && persisted.item) {
    // A row outside the bounded native coverage window never received digest publication or
    // cancellation authority. Demote that new ownership claim durably so it cannot drift into a
    // later aggregate after higher-ranked rows disappear. A future exact occurrence may make a
    // fresh, independently bounded claim; this already-preserved Android original never can.
    persisted.item = updateFeedItemFields(persisted.item.id, {
      metadata: {
        requestedDisposition: 'preserve_original',
      },
    });
    digest = buildPhoneNotificationDigest(config);
    digestCoversInput = digest.coveredEventIds.includes(input.eventId);
  }
  const suppressOriginal = Boolean(
    persisted.item
      && !persisted.tombstoned
      && preserveReason === 'eligible_for_curated_digest'
      && persisted.suppressionIdentityOwned
      && digestCoversInput,
  );
  const effectivePreserveReason = persisted.tombstoned
    ? 'dedupe_tombstoned'
    : persisted.item
      ? preserveReason !== 'eligible_for_curated_digest'
        ? preserveReason
        : !persisted.suppressionIdentityOwned
          ? 'dedupe_identity_preserved'
          : capacityDemoted || !digestCoversInput
            ? 'digest_capacity_preserved'
            : preserveReason
      : 'persistence_failed';
  return {
    ok: true,
    receipt: {
      eventId: input.eventId,
      sourceId: persisted.sourceId,
      persisted: Boolean(persisted.item) && !persisted.tombstoned,
    },
    policy: {
      mode: config.mode,
      replacementAllowed,
      suppressOriginal,
      preserveReason: effectivePreserveReason,
    },
    digest,
    feedItem: persisted.item,
  };
}

export interface PhoneNotificationRemovalResult {
  ok: true;
  eventId: string;
  resolved: boolean;
  feedItem: FeedItem | null;
}

function schedulePhoneNotificationFeedUpdate(feedItem: FeedItem): void {
  // notifyFeedUpdate hydrates its payload synchronously before its first await. Move the entire
  // best-effort UI path to the next event-loop turn so native durable receipts are not charged for
  // that work. This phone runtime is a persistent local Node process; SQLite remains the source of
  // truth if the process exits before the optional broadcast.
  setImmediate(() => {
    void notifyFeedUpdate([feedItem]);
  });
}

export function removePhoneNotification(
  eventIdValue: unknown,
  now = Date.now(),
): PhoneNotificationRemovalResult {
  const eventId = normalizedText(eventIdValue, 64) ?? '';
  if (!isLowerHex(eventId, 64)) {
    throw new Error('eventId must be 64 lowercase hex characters');
  }
  const db = getDb();
  const feedItem = db.transaction(() => {
    prunePhoneNotificationTombstones(now);
    const row = db.prepare(`
      SELECT id, source_id
      FROM feed
      WHERE type = 'notification'
        AND source = 'phone-notification'
        AND json_extract(metadata, '$.lastReceiptEventId') = ?
      ORDER BY created_at_ms DESC
      LIMIT 1
    `).get(eventId) as { id: string; source_id: string | null } | undefined;
    db.prepare(`
      INSERT INTO phone_notification_tombstones (
        event_id, source_id, removed_at_ms
      ) VALUES (?, ?, ?)
      ON CONFLICT(event_id) DO UPDATE SET
        source_id = COALESCE(excluded.source_id, source_id),
        removed_at_ms = MAX(removed_at_ms, excluded.removed_at_ms)
    `).run(eventId, row?.source_id ?? null, now);
    if (!row) return null;
    setFeedItemSuggestionStatus(row.id, 'dismissed', {
      phoneNotificationRemovedAt: new Date(now).toISOString(),
    });
    return getFeedItemById(row.id);
  })();
  return {
    ok: true,
    eventId,
    resolved: Boolean(feedItem),
    feedItem,
  };
}

export async function removeAndNotifyPhoneNotification(
  eventId: unknown,
): Promise<PhoneNotificationRemovalResult> {
  const result = removePhoneNotification(eventId);
  if (result.feedItem) {
    // The native lifecycle callback has a deliberately short deadline. The SQLite tombstone and
    // dismissal above are the durable result; WebSocket publication is only UI freshness and
    // clients reconcile from SQLite if it is late or lost.
    schedulePhoneNotificationFeedUpdate(result.feedItem);
  }
  return result;
}

export async function ingestAndNotifyPhoneNotification(
  input: PhoneNotificationIngestInput,
): Promise<PhoneNotificationIngestResult> {
  const result = await ingestPhoneNotification(input);
  if (result.feedItem) {
    // The native listener has one short end-to-end deadline because the response is its
    // durable cancellation/preservation receipt. WebSocket publication is best-effort UI
    // freshness and must never consume that deadline; clients reconcile from SQLite.
    schedulePhoneNotificationFeedUpdate(result.feedItem);
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
      replacementAllowed: isReplacementAllowedForPackage(config, packageName),
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
      originalsPreservedByDefault: true,
      replacementScopeIsExplicit: true,
      preservedPackagesOverrideScope: true,
      keyOnlyCancellationIsBestEffort: true,
      exactReceiptRequired: true,
      digestProofRequired: true,
    },
  };
}
