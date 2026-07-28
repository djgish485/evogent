import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import {
  classifyPhoneNotification,
  getPhoneNotificationSettingsView,
  ingestPhoneNotification,
  parsePhoneNotificationIngestInput,
  readPhoneNotificationSettings,
  updatePhoneNotificationSettings,
  type PhoneNotificationIngestInput,
} from './phone-notification-curation';
import { getDb } from './db/client';

const originalDataDir = process.env.DATA_DIR;
let temporaryDataDir = '';

function closeDatabase() {
  if (global.evogentDb) {
    global.evogentDb.close();
    delete global.evogentDb;
  }
}

beforeEach(() => {
  closeDatabase();
  temporaryDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-phone-notifications-'));
  process.env.DATA_DIR = temporaryDataDir;
});

afterEach(() => {
  closeDatabase();
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(temporaryDataDir, { recursive: true, force: true });
});

function payload(
  overrides: Record<string, unknown> = {},
): PhoneNotificationIngestInput {
  return parsePhoneNotificationIngestInput({
    schemaVersion: 1,
    eventId: 'a'.repeat(64),
    packageName: 'example.reader',
    appLabel: 'Reader',
    category: 'recommendation',
    channelHash: 'b'.repeat(64),
    flags: 0,
    importance: 3,
    clearable: true,
    ongoing: false,
    fullScreen: false,
    groupSummary: false,
    conversation: false,
    visibility: 0,
    postedAtMs: Date.now(),
    historical: false,
    nativePriority: 'low',
    nativeCanSuppress: true,
    nativeProtectionReason: null,
    contentRedacted: false,
    title: 'A useful update',
    text: 'A concise body',
    subText: null,
    digestCapability: true,
    ...overrides,
  });
}

test('safe settings default to Observe with private lock-screen previews', async () => {
  const state = await readPhoneNotificationSettings();
  assert.equal(state.state, 'default');
  assert.deepEqual(state.config, {
    schemaVersion: 1,
    mode: 'observe',
    lockScreenPreview: 'private',
    preservedPackages: [],
    replacementPackages: [],
  });
});

test('legacy schema-one settings migrate to preserving every Android original', async () => {
  fs.writeFileSync(
    path.join(temporaryDataDir, 'phone-notification-curation.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      mode: 'curated',
      lockScreenPreview: 'private',
      preservedPackages: ['example.legacy'],
    })}\n`,
    { mode: 0o600 },
  );

  const state = await readPhoneNotificationSettings();
  assert.equal(state.state, 'loaded');
  assert.equal(state.config.mode, 'curated');
  assert.deepEqual(state.config.preservedPackages, ['example.legacy']);
  assert.deepEqual(state.config.replacementPackages, []);
});

test('curated mode requires an explicit opt-in and is reversible', async () => {
  await assert.rejects(
    updatePhoneNotificationSettings({ mode: 'curated' }),
    /explicit confirmation/i,
  );
  assert.equal((await readPhoneNotificationSettings()).config.mode, 'observe');

  const curated = await updatePhoneNotificationSettings({
    mode: 'curated',
    confirmCurated: true,
  });
  assert.equal(curated.config.mode, 'curated');
  assert.equal(
    fs.statSync(path.join(temporaryDataDir, 'phone-notification-curation.json')).mode & 0o777,
    0o600,
  );

  const observed = await updatePhoneNotificationSettings({ mode: 'observe' });
  assert.equal(observed.config.mode, 'observe');
});

test('server independently protects urgent, system, ongoing, grouped, secret, and unranked events', () => {
  const protectedCases: Array<[string, Record<string, unknown>]> = [
    ['call', { category: 'call' }],
    ['alarm', { category: 'alarm' }],
    ['navigation', { category: 'navigation' }],
    ['high importance', { importance: 4 }],
    ['unranked', { importance: -1000 }],
    ['ongoing', { ongoing: true }],
    ['foreground service', { flags: 0x40 }],
    ['non-clearable', { clearable: false }],
    ['full-screen', { fullScreen: true }],
    ['group summary', { groupSummary: true }],
    ['system safety', { packageName: 'com.android.systemui' }],
    ['secret visibility', { visibility: -1 }],
    ['one-time code', { text: 'Your verification code is 123456' }],
  ];
  for (const [label, overrides] of protectedCases) {
    const classification = classifyPhoneNotification(payload(overrides));
    assert.equal(
      classification.protectedFromSuppression,
      true,
      `${label} was not protected`,
    );
  }
});

test('Observe mirrors and deduplicates locally without requesting suppression', async () => {
  const first = await ingestPhoneNotification(payload());
  const second = await ingestPhoneNotification(payload({
    eventId: 'c'.repeat(64),
    postedAtMs: Date.now() + 1,
  }));

  assert.equal(first.receipt.persisted, true);
  assert.equal(first.receipt.eventId, 'a'.repeat(64));
  assert.equal(first.policy.mode, 'observe');
  assert.equal(first.policy.suppressOriginal, false);
  assert.equal(second.receipt.sourceId, first.receipt.sourceId);

  const rows = getDb().prepare(`
    SELECT metadata
    FROM feed
    WHERE type = 'notification' AND source = 'phone-notification'
  `).all() as Array<{ metadata: string }>;
  assert.equal(rows.length, 1);
  const metadata = JSON.parse(rows[0].metadata) as Record<string, unknown>;
  assert.equal(metadata.occurrences, 2);
  assert.equal(metadata.requestedDisposition, 'preserve_original');
});

test('sensitive content is redacted from durable local feed data', async () => {
  const secret = 'Your verification code is 123456';
  const result = await ingestPhoneNotification(payload({
    packageName: 'example.accounts',
    category: 'message',
    nativePriority: 'high',
    text: secret,
  }));
  assert.equal(result.receipt.persisted, true);
  assert.equal(result.policy.suppressOriginal, false);

  const row = getDb().prepare(`
    SELECT title, text, metadata
    FROM feed
    WHERE source_id = ?
  `).get(result.receipt.sourceId) as {
    title: string;
    text: string;
    metadata: string;
  };
  assert.doesNotMatch(JSON.stringify(row), /123456|verification code/i);
  assert.match(row.text, /contents were not stored/i);
  assert.equal((JSON.parse(row.metadata) as Record<string, unknown>).contentRedacted, true);
});

test('Curated preserves originals until per-app best-effort replacement is explicitly allowed', async () => {
  await updatePhoneNotificationSettings({ mode: 'curated', confirmCurated: true });

  const preservedByDefault = await ingestPhoneNotification(payload());
  assert.equal(preservedByDefault.receipt.persisted, true);
  assert.equal(preservedByDefault.policy.replacementAllowed, false);
  assert.equal(preservedByDefault.policy.suppressOriginal, false);
  assert.equal(preservedByDefault.policy.preserveReason, 'app_not_replacement_allowed');

  await assert.rejects(
    updatePhoneNotificationSettings({ replacementPackages: ['example.reader'] }),
    /explicit best-effort confirmation/i,
  );
  await updatePhoneNotificationSettings({
    replacementPackages: ['example.reader'],
    confirmBestEffortReplacement: true,
  });

  const eligible = await ingestPhoneNotification(payload());
  assert.equal(eligible.receipt.persisted, true);
  assert.equal(eligible.policy.replacementAllowed, true);
  assert.equal(eligible.policy.suppressOriginal, true);
  assert.equal(eligible.policy.preserveReason, 'eligible_for_curated_digest');

  const noDigest = await ingestPhoneNotification(payload({
    eventId: 'd'.repeat(64),
    digestCapability: false,
    postedAtMs: Date.now() + 2,
  }));
  assert.equal(noDigest.policy.suppressOriginal, false);
  assert.equal(noDigest.policy.preserveReason, 'digest_unavailable');

  const nativeIneligible = await ingestPhoneNotification(payload({
    eventId: 'e'.repeat(64),
    nativeCanSuppress: false,
    postedAtMs: Date.now() + 3,
  }));
  assert.equal(nativeIneligible.policy.suppressOriginal, false);
  assert.equal(nativeIneligible.policy.preserveReason, 'native_ineligible');

  const historical = await ingestPhoneNotification(payload({
    eventId: 'f'.repeat(64),
    historical: true,
    postedAtMs: Date.now() + 4,
  }));
  assert.equal(historical.policy.suppressOriginal, false);
  assert.equal(historical.policy.preserveReason, 'historical_scan');

  await updatePhoneNotificationSettings({ replacementPackages: [] });
  const revoked = await ingestPhoneNotification(payload({
    eventId: '9'.repeat(64),
    postedAtMs: Date.now() + 5,
  }));
  assert.equal(revoked.policy.replacementAllowed, false);
  assert.equal(revoked.policy.suppressOriginal, false);
  assert.equal(revoked.policy.preserveReason, 'app_not_replacement_allowed');
});

test('Curated mode never suppresses a user-preserved app or protected event', async () => {
  await updatePhoneNotificationSettings({
    mode: 'curated',
    confirmCurated: true,
    preservedPackages: ['example.reader'],
    replacementPackages: ['example.reader'],
    confirmBestEffortReplacement: true,
  });
  const preserved = await ingestPhoneNotification(payload());
  assert.equal(preserved.policy.replacementAllowed, false);
  assert.equal(preserved.policy.suppressOriginal, false);
  assert.equal(preserved.policy.preserveReason, 'app_preserved');
  const preservedView = await getPhoneNotificationSettingsView();
  assert.equal(preservedView.observedApps[0].replacementAllowed, false);

  await updatePhoneNotificationSettings({ preservedPackages: [] });
  const alarm = await ingestPhoneNotification(payload({
    eventId: '1'.repeat(64),
    category: 'alarm',
    nativeCanSuppress: false,
  }));
  assert.equal(alarm.policy.suppressOriginal, false);
  assert.equal(alarm.policy.preserveReason, 'protected_category');
});

test('Paused mode stores no event and can never produce a cancellation receipt', async () => {
  await updatePhoneNotificationSettings({ mode: 'paused' });
  const result = await ingestPhoneNotification(payload());
  assert.equal(result.receipt.persisted, false);
  assert.equal(result.receipt.sourceId, null);
  assert.equal(result.policy.suppressOriginal, false);
  const count = getDb().prepare(`SELECT COUNT(*) AS count FROM feed`)
    .get() as { count: number };
  assert.equal(count.count, 0);
});

test('eligible content-app notification keeps the existing lightweight browse signal', async () => {
  const result = await ingestPhoneNotification(payload({
    packageName: 'com.reddit.frontpage',
    appLabel: 'Reddit',
  }));
  assert.equal(result.receipt.persisted, true);
  const row = getDb().prepare(`
    SELECT source, payload_json
    FROM browse_cache_items
    WHERE source = 'reddit'
  `).get() as { source: string; payload_json: string };
  assert.equal(row.source, 'reddit');
  assert.match(row.payload_json, /phone-notification-listener/);
});

test('settings view exposes observed apps and immutable safeguards without notification content', async () => {
  await ingestPhoneNotification(payload());
  const view = await getPhoneNotificationSettingsView();
  assert.equal(view.observedApps.length, 1);
  assert.equal(view.observedApps[0].label, 'Reader');
  assert.equal(view.observedApps[0].replacementAllowed, false);
  assert.equal(view.safeguards.observeIsDefault, true);
  assert.equal(view.safeguards.originalsPreservedByDefault, true);
  assert.equal(view.safeguards.replacementIsPerPackage, true);
  assert.equal(view.safeguards.keyOnlyCancellationIsBestEffort, true);
  assert.equal(view.safeguards.exactReceiptRequired, true);
  assert.equal(view.safeguards.digestProofRequired, true);
  assert.doesNotMatch(JSON.stringify(view), /A useful update|A concise body/);
});

test('ingest parser rejects stale, future, malformed, and partial native payloads', () => {
  assert.throws(
    () => payload({ eventId: 'not-a-receipt' }),
    /eventId/i,
  );
  assert.throws(
    () => payload({ postedAtMs: Date.now() + 10 * 60 * 1000 }),
    /postedAtMs/i,
  );
  assert.throws(
    () => parsePhoneNotificationIngestInput({ schemaVersion: 1 }),
    /eventId/i,
  );
});
