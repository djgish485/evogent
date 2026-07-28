import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';

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
import {
  getSourceDueSignalPath,
  SOURCE_DUE_SIGNAL_MARKER,
} from './source-due-signal';

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
  mock.restoreAll();
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

test('eligible content-app notification writes only a content-free source due marker', async () => {
  const arbitraryPrivateText = 'PRIVATE_CANARY_notification_body_84219';
  const result = await ingestPhoneNotification(payload({
    packageName: 'com.reddit.frontpage',
    appLabel: 'Private reader app label',
    title: 'Private canary title',
    text: arbitraryPrivateText,
    subText: 'Private canary subtext',
  }));
  assert.equal(result.receipt.persisted, true);
  const browseCacheCount = getDb().prepare(`
    SELECT COUNT(*) AS count
    FROM browse_cache_items
  `).get() as { count: number };
  assert.equal(browseCacheCount.count, 0);

  const signalPath = getSourceDueSignalPath('reddit');
  assert.equal(fs.readFileSync(signalPath, 'utf8'), SOURCE_DUE_SIGNAL_MARKER);
  assert.equal(fs.statSync(signalPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(signalPath)).mode & 0o777, 0o700);
  const signalFiles = fs.readdirSync(path.dirname(signalPath));
  assert.deepEqual(signalFiles, ['reddit.due']);
  const signalStorage = signalFiles
    .map((name) => fs.readFileSync(path.join(path.dirname(signalPath), name), 'utf8'))
    .join('\n');
  assert.doesNotMatch(
    signalStorage,
    /PRIVATE_CANARY|notification_body|com\.reddit|Private (?:canary|reader)/i,
  );
});

test('YouTube, X, and Substack notifications use canonical content-free source markers', async () => {
  const mappings = [
    ['com.google.android.youtube', 'youtube', 'c'],
    ['com.twitter.android', 'twitter', 'd'],
    ['com.substack.app', 'substack-app', 'e'],
  ] as const;
  for (const [packageName, source, eventCharacter] of mappings) {
    const result = await ingestPhoneNotification(payload({
      eventId: eventCharacter.repeat(64),
      packageName,
      appLabel: 'Private app label',
      title: 'Private notification title',
      text: 'Private notification body',
    }));
    assert.equal(result.receipt.persisted, true);
    assert.equal(
      fs.readFileSync(getSourceDueSignalPath(source), 'utf8'),
      SOURCE_DUE_SIGNAL_MARKER,
    );
  }
  const browseCacheCount = getDb().prepare(`
    SELECT COUNT(*) AS count
    FROM browse_cache_items
  `).get() as { count: number };
  assert.equal(browseCacheCount.count, 0);
});

test('source due publication fsyncs the renamed marker and its parent directory', async () => {
  const originalFsync = fs.fsyncSync.bind(fs);
  const synchronizedKinds: string[] = [];
  mock.method(fs, 'fsyncSync', (descriptor: number) => {
    synchronizedKinds.push(fs.fstatSync(descriptor).isDirectory() ? 'directory' : 'file');
    originalFsync(descriptor);
  });

  await ingestPhoneNotification(payload({
    packageName: 'com.reddit.frontpage',
    appLabel: 'Private reader app label',
  }));

  assert.deepEqual(synchronizedKinds, ['file', 'file', 'directory']);
  assert.equal(
    fs.readFileSync(getSourceDueSignalPath('reddit'), 'utf8'),
    SOURCE_DUE_SIGNAL_MARKER,
  );
});

test('redacted or conversational content-app notifications write no due marker', async () => {
  await ingestPhoneNotification(payload({
    packageName: 'com.google.android.gm',
    appLabel: 'Mail',
    text: 'Your verification code is 123456',
  }));
  await ingestPhoneNotification(payload({
    eventId: 'f'.repeat(64),
    packageName: 'com.twitter.android',
    appLabel: 'X',
    category: 'message',
    conversation: true,
    title: 'Private conversation',
    text: 'Private direct message',
  }));
  assert.equal(fs.existsSync(getSourceDueSignalPath('gmail')), false);
  assert.equal(fs.existsSync(getSourceDueSignalPath('twitter')), false);
  const browseCacheCount = getDb().prepare(`
    SELECT COUNT(*) AS count
    FROM browse_cache_items
  `).get() as { count: number };
  assert.equal(browseCacheCount.count, 0);
});

test('database startup purges legacy notification-content browse signals', () => {
  const privateCanary = 'LEGACY_PRIVATE_NOTIFICATION_CANARY_9182';
  const database = getDb();
  database.prepare(`
    INSERT INTO browse_cache_items (
      source, source_id, title, payload_json, fetched_at_ms, expires_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    'reddit',
    'notif-legacy-content-signal',
    privateCanary,
    JSON.stringify({
      type: 'notification-signal',
      title: privateCanary,
      text: privateCanary,
      captureMethod: 'phone-notification-listener',
    }),
    Date.now(),
    Date.now() + 60_000,
  );
  database.prepare(`
    INSERT INTO browse_cache_refresh_runs (
      id, source, triggered_by, started_at_ms, completed_at_ms,
      status, items_added, error, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'legacy-phone-notification-refresh',
    'reddit',
    'phone-notification-listener',
    Date.now(),
    Date.now(),
    'completed',
    1,
    null,
    null,
  );
  closeDatabase();

  const reopened = getDb();
  const cacheCount = reopened.prepare(`
    SELECT COUNT(*) AS count
    FROM browse_cache_items
    WHERE source_id = 'notif-legacy-content-signal'
  `).get() as { count: number };
  const refreshCount = reopened.prepare(`
    SELECT COUNT(*) AS count
    FROM browse_cache_refresh_runs
    WHERE triggered_by = 'phone-notification-listener'
  `).get() as { count: number };
  assert.equal(cacheCount.count, 0);
  assert.equal(refreshCount.count, 0);
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
