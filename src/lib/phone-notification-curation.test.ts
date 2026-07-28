import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

import {
  classifyPhoneNotification,
  didPhoneNotificationReplacementAuthorityDecrease,
  getPhoneNotificationSettingsView,
  ingestPhoneNotification,
  parsePhoneNotificationIngestInput,
  PHONE_NOTIFICATION_AUTHORITY_REVOCATION_DRAIN_MS,
  readPhoneNotificationSettings,
  removePhoneNotification,
  updatePhoneNotificationSettings as updatePhoneNotificationSettingsWithBarrier,
  waitForPhoneNotificationAuthorityRevocationDrain,
  type PhoneNotificationIngestInput,
  type PhoneNotificationSettings,
} from './phone-notification-curation';
import { getDb } from './db/client';
import {
  getSourceDueSignalPath,
  signalSourceDue,
  SOURCE_DUE_SIGNAL_MARKER,
  SOURCE_DUE_SIGNAL_PENDING_MODE,
} from './source-due-signal';

const originalDataDir = process.env.DATA_DIR;
let temporaryDataDir = '';

function closeDatabase() {
  if (global.evogentDb) {
    global.evogentDb.close();
    delete global.evogentDb;
  }
}

function immediateRevocationBarrier() {
  let monotonicNow = 0;
  return {
    monotonicNow: () => monotonicNow,
    sleep: async (delayMs: number) => {
      monotonicNow += delayMs;
    },
  };
}

function updatePhoneNotificationSettings(patch: unknown) {
  return updatePhoneNotificationSettingsWithBarrier(
    patch,
    immediateRevocationBarrier(),
  );
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
    nativeCategoryWireExact: true,
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
    replacementScope: 'per_app',
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
  assert.equal(state.config.replacementScope, 'per_app');
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

test('settings replacement and revocation fsync the final inode and parent directory', async () => {
  const originalFsync = fs.fsyncSync.bind(fs);
  const synchronizedKinds: string[] = [];
  mock.method(fs, 'fsyncSync', (descriptor: number) => {
    synchronizedKinds.push(fs.fstatSync(descriptor).isDirectory() ? 'directory' : 'file');
    originalFsync(descriptor);
  });

  await updatePhoneNotificationSettings({
    mode: 'curated',
    confirmCurated: true,
    replacementPackages: ['example.reader'],
    confirmBestEffortReplacement: true,
  });
  await updatePhoneNotificationSettings({ replacementPackages: [] });

  assert.deepEqual(synchronizedKinds, [
    'file', 'file', 'directory',
    'file', 'file', 'directory',
  ]);
  assert.deepEqual(
    (await readPhoneNotificationSettings()).config.replacementPackages,
    [],
  );
});

test('only effective replacement-authority reductions require the native deadline drain', () => {
  const perApp: PhoneNotificationSettings = {
    schemaVersion: 1,
    mode: 'curated',
    lockScreenPreview: 'private',
    replacementScope: 'per_app',
    preservedPackages: [],
    replacementPackages: ['example.reader'],
  };
  assert.equal(didPhoneNotificationReplacementAuthorityDecrease(
    perApp,
    { ...perApp, replacementPackages: ['example.reader', 'example.second'] },
  ), false);
  assert.equal(didPhoneNotificationReplacementAuthorityDecrease(
    perApp,
    { ...perApp, lockScreenPreview: 'detailed' },
  ), false);
  assert.equal(didPhoneNotificationReplacementAuthorityDecrease(
    perApp,
    { ...perApp, replacementPackages: [] },
  ), true);
  assert.equal(didPhoneNotificationReplacementAuthorityDecrease(
    perApp,
    { ...perApp, preservedPackages: ['example.reader'] },
  ), true);
  assert.equal(didPhoneNotificationReplacementAuthorityDecrease(
    perApp,
    { ...perApp, mode: 'observe' },
  ), true);

  const broad = { ...perApp, replacementScope: 'all_eligible' as const };
  assert.equal(didPhoneNotificationReplacementAuthorityDecrease(
    broad,
    { ...broad, replacementScope: 'per_app' },
  ), true);
  assert.equal(didPhoneNotificationReplacementAuthorityDecrease(
    broad,
    { ...broad, replacementPackages: [] },
  ), false);
  assert.equal(didPhoneNotificationReplacementAuthorityDecrease(
    { ...perApp, mode: 'observe' },
    { ...perApp, mode: 'observe', replacementPackages: [] },
  ), false);
});

test('revocation waits beyond the native deadline after durable persistence without sleeping', async () => {
  await updatePhoneNotificationSettings({
    mode: 'curated',
    confirmCurated: true,
    replacementPackages: ['example.reader'],
    confirmBestEffortReplacement: true,
  });

  let monotonicNow = 100;
  let releaseSleep!: () => void;
  const sleepStarted = new Promise<void>((resolve) => {
    releaseSleep = resolve;
  });
  let updateSettled = false;
  const update = updatePhoneNotificationSettingsWithBarrier(
    { replacementPackages: [] },
    {
      monotonicNow: () => monotonicNow,
      sleep: async (delayMs) => {
        assert.equal(delayMs, PHONE_NOTIFICATION_AUTHORITY_REVOCATION_DRAIN_MS);
        assert.deepEqual(
          JSON.parse(fs.readFileSync(
            path.join(temporaryDataDir, 'phone-notification-curation.json'),
            'utf8',
          )).replacementPackages,
          [],
        );
        await sleepStarted;
        monotonicNow += delayMs;
      },
    },
  ).finally(() => {
    updateSettled = true;
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(updateSettled, false);
  releaseSleep();
  await update;
  assert.equal(updateSettled, true);
});

test('revocation drain rechecks the monotonic deadline after an early timer wakeup', async () => {
  let monotonicNow = 0;
  const sleepCalls: number[] = [];
  await waitForPhoneNotificationAuthorityRevocationDrain(true, {
    monotonicNow: () => monotonicNow,
    sleep: async (delayMs) => {
      sleepCalls.push(delayMs);
      monotonicNow += sleepCalls.length === 1 ? delayMs - 1 : delayMs;
    },
  });

  assert.deepEqual(sleepCalls, [
    PHONE_NOTIFICATION_AUTHORITY_REVOCATION_DRAIN_MS,
    1,
  ]);

  await waitForPhoneNotificationAuthorityRevocationDrain(false, {
    monotonicNow: () => {
      throw new Error('non-reducing updates must not read the barrier clock');
    },
    sleep: async () => {
      throw new Error('non-reducing updates must not sleep');
    },
  });
});

test('concurrent unrelated PATCH cannot resurrect a durably revoked replacement package across route bundles', async () => {
  await updatePhoneNotificationSettings({
    mode: 'curated',
    confirmCurated: true,
    replacementPackages: ['example.reader'],
    confirmBestEffortReplacement: true,
  });

  const moduleUrl = pathToFileURL(
    path.join(process.cwd(), 'src/lib/phone-notification-curation.ts'),
  ).href;
  const unrelatedBundle = await import(`${moduleUrl}?settings-bundle=unrelated-${Date.now()}`);
  const revocationBundle = await import(`${moduleUrl}?settings-bundle=revoke-${Date.now()}`);
  const settingsFilePath = path.join(
    temporaryDataDir,
    'phone-notification-curation.json',
  );
  const originalReadFile = fs.promises.readFile.bind(fs.promises);
  let firstRead = true;
  let settingsReadCount = 0;
  let announceFirstRead!: () => void;
  let releaseFirstRead!: () => void;
  const firstReadStarted = new Promise<void>((resolve) => {
    announceFirstRead = resolve;
  });
  const firstReadCanReturn = new Promise<void>((resolve) => {
    releaseFirstRead = resolve;
  });

  mock.method(fs.promises, 'readFile', async (...args) => {
    // Capture the bytes first. Without one process-global read/merge/write lock,
    // this held unrelated PATCH would later overwrite a completed revocation
    // with the stale replacementPackages array it captured here.
    const contents = await originalReadFile(...args);
    if (args[0] === settingsFilePath) {
      settingsReadCount += 1;
      if (firstRead) {
        firstRead = false;
        announceFirstRead();
        await firstReadCanReturn;
      }
    }
    return contents;
  });

  let unrelatedSettled = false;
  let revocationSettled = false;
  const unrelatedPatch = unrelatedBundle.updatePhoneNotificationSettings({
    lockScreenPreview: 'detailed',
  }).finally(() => {
    unrelatedSettled = true;
  });
  await firstReadStarted;
  const revocationPatch = revocationBundle.updatePhoneNotificationSettings({
    replacementPackages: [],
  }, immediateRevocationBarrier()).finally(() => {
    revocationSettled = true;
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settingsReadCount, 1);
  assert.equal(unrelatedSettled, false);
  assert.equal(revocationSettled, false);

  releaseFirstRead();
  await Promise.all([unrelatedPatch, revocationPatch]);

  const finalConfig = (await readPhoneNotificationSettings()).config;
  assert.equal(finalConfig.lockScreenPreview, 'detailed');
  assert.deepEqual(finalConfig.replacementPackages, []);
  assert.equal(settingsReadCount, 3);
});

test('server independently protects urgent, system, communication, unknown, ongoing, grouped, secret, and unranked events', () => {
  const protectedCases: Array<[string, Record<string, unknown>]> = [
    ['call', { category: 'call' }],
    ['alarm', { category: 'alarm' }],
    ['navigation', { category: 'navigation' }],
    ['Android system literal', { category: 'sys' }],
    ['Android error/authentication literal', { category: 'err' }],
    ['Android message literal', { category: 'msg' }],
    ['email', { category: 'email' }],
    ['voicemail', { category: 'voicemail' }],
    ['missed call', { category: 'missed_call' }],
    ['car emergency', { category: 'car_emergency' }],
    ['car warning', { category: 'car_warning' }],
    ['car information', { category: 'car_information' }],
    ['unknown category', { category: 'vendor_private_category' }],
    ['missing category', { category: null }],
    ['conversation', { conversation: true }],
    ['native protection', { nativeProtectionReason: 'native_policy' }],
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

test('server replacement allowlist contains only low-stakes editorial categories', () => {
  for (const category of ['promo', 'recommendation', 'social']) {
    const classification = classifyPhoneNotification(payload({ category }));
    assert.equal(
      classification.protectedFromSuppression,
      false,
      `${category} should remain eligible for the later per-package policy gates`,
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

  for (const [eventCharacter, category] of [
    ['2', 'car_emergency'],
    ['3', 'car_warning'],
    ['4', 'msg'],
    ['5', 'email'],
    ['6', 'voicemail'],
    ['7', 'vendor_unknown'],
  ] as const) {
    const protectedResult = await ingestPhoneNotification(payload({
      eventId: eventCharacter.repeat(64),
      category,
      nativeCanSuppress: true,
      digestCapability: true,
      postedAtMs: Date.now() + Number(eventCharacter),
    }));
    assert.equal(
      protectedResult.policy.suppressOriginal,
      false,
      `${category} must stay Android-owned`,
    );
    assert.match(
      protectedResult.policy.preserveReason,
      /protected_category|category_unavailable/,
    );
  }
});

test('all-eligible scope is explicit and preserved apps remain authoritative', async () => {
  await assert.rejects(
    updatePhoneNotificationSettings({ replacementScope: 'all_eligible' }),
    /explicit best-effort confirmation/i,
  );
  await updatePhoneNotificationSettings({
    mode: 'curated',
    confirmCurated: true,
    replacementScope: 'all_eligible',
    confirmBestEffortReplacement: true,
    preservedPackages: ['example.preserved'],
  });

  const eligible = await ingestPhoneNotification(payload({
    packageName: 'example.editorial',
  }));
  assert.equal(eligible.policy.replacementAllowed, true);
  assert.equal(eligible.policy.suppressOriginal, true);

  const preserved = await ingestPhoneNotification(payload({
    eventId: '2'.repeat(64),
    packageName: 'example.preserved',
    postedAtMs: Date.now() + 1,
  }));
  assert.equal(preserved.policy.replacementAllowed, false);
  assert.equal(preserved.policy.suppressOriginal, false);
  assert.equal(preserved.policy.preserveReason, 'app_preserved');

  const narrowed = await updatePhoneNotificationSettings({
    replacementScope: 'per_app',
  });
  assert.equal(narrowed.config.replacementScope, 'per_app');
});

test('digest aggregates and priority-ranks active eligible notification receipts', async () => {
  await updatePhoneNotificationSettings({
    mode: 'curated',
    confirmCurated: true,
    replacementScope: 'all_eligible',
    confirmBestEffortReplacement: true,
  });
  const baseTime = Date.now();
  const lowPostedAtMs = baseTime - 100;
  const low = await ingestPhoneNotification(payload({
    eventId: '3'.repeat(64),
    packageName: 'example.first',
    appLabel: 'First',
    nativePriority: 'low',
    postedAtMs: lowPostedAtMs,
  }));
  const normal = await ingestPhoneNotification(payload({
    eventId: '4'.repeat(64),
    packageName: 'example.second',
    appLabel: 'Second',
    category: 'social',
    nativePriority: 'normal',
    postedAtMs: baseTime,
  }));

  assert.equal(low.digest.activeCount, 1);
  assert.equal(low.digest.expiresAtMs, lowPostedAtMs + 3 * 24 * 60 * 60 * 1000);
  assert.equal(normal.digest.activeCount, 2);
  assert.equal(normal.digest.expiresAtMs, low.digest.expiresAtMs);
  assert.deepEqual(normal.digest.coveredEventIds, [
    '4'.repeat(64),
    '3'.repeat(64),
  ]);
  assert.match(normal.digest.title, /2 curated notifications/);
  assert.match(normal.digest.text, /Second.*First/);
});

test('native digest excludes legacy rows without a valid finite expiry', async () => {
  await updatePhoneNotificationSettings({
    mode: 'curated',
    confirmCurated: true,
    replacementScope: 'all_eligible',
    confirmBestEffortReplacement: true,
  });
  const baseTime = Date.now();
  const missingExpiry = await ingestPhoneNotification(payload({
    eventId: '1'.repeat(64),
    packageName: 'example.missingexpiry',
    postedAtMs: baseTime - 2_000,
  }));
  const invalidExpiry = await ingestPhoneNotification(payload({
    eventId: '2'.repeat(64),
    packageName: 'example.invalidexpiry',
    postedAtMs: baseTime - 1_000,
  }));
  getDb().prepare(`
    UPDATE feed
    SET metadata = json_remove(metadata, '$.expiresAt')
    WHERE source_id = ?
  `).run(missingExpiry.receipt.sourceId);
  getDb().prepare(`
    UPDATE feed
    SET metadata = json_set(metadata, '$.expiresAt', 'not-a-date')
    WHERE source_id = ?
  `).run(invalidExpiry.receipt.sourceId);

  const currentEventId = '3'.repeat(64);
  const current = await ingestPhoneNotification(payload({
    eventId: currentEventId,
    packageName: 'example.currentexpiry',
    postedAtMs: baseTime,
  }));

  assert.deepEqual(current.digest.coveredEventIds, [currentEventId]);
  assert.equal(current.digest.activeCount, 1);
  assert.equal(current.digest.expiresAtMs, baseTime + 3 * 24 * 60 * 60 * 1000);
});

test('aggregate digest count is fully owned by its bounded native coverage window', async () => {
  await updatePhoneNotificationSettings({
    mode: 'curated',
    confirmCurated: true,
    replacementScope: 'all_eligible',
    confirmBestEffortReplacement: true,
  });
  const baseTime = Date.now();
  let latest: Awaited<ReturnType<typeof ingestPhoneNotification>> | null = null;
  for (let index = 0; index < 35; index += 1) {
    latest = await ingestPhoneNotification(payload({
      eventId: (index + 1).toString(16).padStart(64, '0'),
      packageName: `example.digest${index}`,
      appLabel: `Digest ${index}`,
      postedAtMs: baseTime + index,
    }));
  }

  assert.equal(latest?.digest.activeCount, 32);
  assert.equal(latest?.digest.coveredEventIds.length, 32);
  assert.equal(
    latest?.digest.coveredEventIds[0],
    (35).toString(16).padStart(64, '0'),
  );
  assert.equal(
    latest?.digest.expiresAtMs,
    baseTime + 3 + 3 * 24 * 60 * 60 * 1000,
  );
  assert.match(latest?.digest.title ?? '', /32 recent curated notifications/);
  assert.match(latest?.digest.text ?? '', /more in Evogent/);
  assert.doesNotMatch(latest?.digest.title ?? '', /35/);
  assert.equal(latest?.policy.suppressOriginal, true);
});

test('a capacity-excluded identity is durably preserved and cannot enter a later digest', async () => {
  await updatePhoneNotificationSettings({
    mode: 'curated',
    confirmCurated: true,
    replacementScope: 'all_eligible',
    confirmBestEffortReplacement: true,
  });
  const bucketMs = 6 * 60 * 60 * 1000;
  const baseTime = Math.floor(Date.now() / bucketMs) * bucketMs + 1_000;
  const coveredEventIds: string[] = [];
  for (let index = 1; index <= 32; index += 1) {
    const eventId = index.toString(16).padStart(64, '0');
    coveredEventIds.push(eventId);
    const result = await ingestPhoneNotification(payload({
      eventId,
      packageName: `example.capacity${index}`,
      category: 'social',
      nativePriority: 'normal',
      postedAtMs: baseTime + index,
    }));
    assert.equal(result.policy.suppressOriginal, true);
  }

  const excludedEventId = 'f'.repeat(64);
  const excluded = await ingestPhoneNotification(payload({
    eventId: excludedEventId,
    packageName: 'example.capacityexcluded',
    nativePriority: 'low',
    postedAtMs: baseTime + 100,
  }));
  assert.equal(excluded.policy.suppressOriginal, false);
  assert.equal(excluded.policy.preserveReason, 'digest_capacity_preserved');
  assert.equal(excluded.digest.activeCount, 32);
  assert.equal(excluded.digest.coveredEventIds.includes(excludedEventId), false);

  const excludedRow = getDb().prepare(`
    SELECT metadata
    FROM feed
    WHERE source_id = ?
  `).get(excluded.receipt.sourceId) as { metadata: string };
  assert.equal(
    (JSON.parse(excludedRow.metadata) as Record<string, unknown>).requestedDisposition,
    'preserve_original',
  );

  for (const eventId of coveredEventIds) {
    assert.equal(removePhoneNotification(eventId).resolved, true);
  }
  const triggerEventId = 'a'.repeat(63) + '1';
  const trigger = await ingestPhoneNotification(payload({
    eventId: triggerEventId,
    packageName: 'example.capacitytrigger',
    category: 'social',
    nativePriority: 'normal',
    postedAtMs: baseTime + 200,
  }));
  assert.equal(trigger.policy.suppressOriginal, true);
  assert.deepEqual(trigger.digest.coveredEventIds, [triggerEventId]);
  assert.equal(trigger.digest.coveredEventIds.includes(excludedEventId), false);
});

test('a curated dedupe owner is immutable and later occurrences stay in Android', async () => {
  await updatePhoneNotificationSettings({
    mode: 'curated',
    confirmCurated: true,
    replacementScope: 'all_eligible',
    confirmBestEffortReplacement: true,
  });
  const bucketMs = 6 * 60 * 60 * 1000;
  const baseTime = Math.floor(Date.now() / bucketMs) * bucketMs + 1_000;
  const ownerEventId = '8'.repeat(64);
  const laterEventId = '9'.repeat(64);
  const owner = await ingestPhoneNotification(payload({
    eventId: ownerEventId,
    postedAtMs: baseTime,
  }));
  const later = await ingestPhoneNotification(payload({
    eventId: laterEventId,
    postedAtMs: baseTime + 1_000,
  }));

  assert.equal(owner.policy.suppressOriginal, true);
  assert.equal(later.receipt.sourceId, owner.receipt.sourceId);
  assert.equal(later.receipt.persisted, true);
  assert.equal(later.policy.suppressOriginal, false);
  assert.equal(later.policy.preserveReason, 'dedupe_identity_preserved');
  assert.deepEqual(later.digest.coveredEventIds, [ownerEventId]);
  assert.equal(later.digest.activeCount, 1);

  const row = getDb().prepare(`
    SELECT metadata
    FROM feed
    WHERE source_id = ?
  `).get(owner.receipt.sourceId) as { metadata: string };
  const metadata = JSON.parse(row.metadata) as Record<string, unknown>;
  assert.equal(metadata.lastReceiptEventId, ownerEventId);
  assert.equal(metadata.requestedDisposition, 'curated_digest');
  assert.equal(metadata.occurrences, 2);
  assert.equal(metadata.lastPostedAt, new Date(baseTime + 1_000).toISOString());

  const removed = removePhoneNotification(ownerEventId);
  assert.equal(removed.resolved, true);
  const repeatedLater = await ingestPhoneNotification(payload({
    eventId: laterEventId,
    postedAtMs: baseTime + 1_000,
  }));
  assert.equal(repeatedLater.receipt.persisted, false);
  assert.equal(repeatedLater.policy.preserveReason, 'dedupe_tombstoned');
});

test('LIFO completion cannot regress a dedupe owner or its display timestamp', async () => {
  await updatePhoneNotificationSettings({
    mode: 'curated',
    confirmCurated: true,
    replacementScope: 'all_eligible',
    confirmBestEffortReplacement: true,
  });
  const bucketMs = 6 * 60 * 60 * 1000;
  const baseTime = Math.floor(Date.now() / bucketMs) * bucketMs + 2_000;
  const newerEventId = 'c'.repeat(64);
  const olderEventId = 'b'.repeat(64);
  const newer = await ingestPhoneNotification(payload({
    eventId: newerEventId,
    appLabel: 'Fresh label',
    postedAtMs: baseTime + 2_000,
  }));
  const olderCompletingLater = await ingestPhoneNotification(payload({
    eventId: olderEventId,
    appLabel: 'Stale label',
    postedAtMs: baseTime + 1_000,
  }));

  assert.equal(newer.policy.suppressOriginal, true);
  assert.equal(olderCompletingLater.policy.suppressOriginal, false);
  assert.equal(
    olderCompletingLater.policy.preserveReason,
    'dedupe_identity_preserved',
  );
  assert.deepEqual(olderCompletingLater.digest.coveredEventIds, [newerEventId]);

  const row = getDb().prepare(`
    SELECT title, published_at, metadata
    FROM feed
    WHERE source_id = ?
  `).get(newer.receipt.sourceId) as {
    title: string;
    published_at: string;
    metadata: string;
  };
  const metadata = JSON.parse(row.metadata) as Record<string, unknown>;
  assert.match(row.title, /Fresh label/);
  assert.doesNotMatch(row.title, /Stale label/);
  assert.equal(row.published_at, new Date(baseTime + 2_000).toISOString());
  assert.equal(metadata.appLabel, 'Fresh label');
  assert.equal(metadata.lastReceiptEventId, newerEventId);
});

test('revocation preserves an existing curated owner while later originals remain', async () => {
  await updatePhoneNotificationSettings({
    mode: 'curated',
    confirmCurated: true,
    replacementScope: 'all_eligible',
    confirmBestEffortReplacement: true,
  });
  const bucketMs = 6 * 60 * 60 * 1000;
  const baseTime = Math.floor(Date.now() / bucketMs) * bucketMs + 3_000;
  const ownerEventId = 'd'.repeat(64);
  const owner = await ingestPhoneNotification(payload({
    eventId: ownerEventId,
    postedAtMs: baseTime,
  }));
  await updatePhoneNotificationSettings({ mode: 'observe' });
  const observedDuplicate = await ingestPhoneNotification(payload({
    eventId: 'e'.repeat(64),
    postedAtMs: baseTime + 1_000,
  }));

  assert.equal(observedDuplicate.policy.mode, 'observe');
  assert.equal(observedDuplicate.policy.suppressOriginal, false);
  assert.equal(observedDuplicate.policy.preserveReason, 'observe_mode');
  assert.deepEqual(observedDuplicate.digest.coveredEventIds, [ownerEventId]);
  assert.equal(observedDuplicate.receipt.sourceId, owner.receipt.sourceId);

  const row = getDb().prepare(`
    SELECT metadata
    FROM feed
    WHERE source_id = ?
  `).get(owner.receipt.sourceId) as { metadata: string };
  const metadata = JSON.parse(row.metadata) as Record<string, unknown>;
  assert.equal(metadata.lastReceiptEventId, ownerEventId);
  assert.equal(metadata.requestedDisposition, 'curated_digest');
  assert.equal(metadata.curationMode, 'curated');
});

test('a never-curated dedupe row can promote its first newer curated owner', async () => {
  const bucketMs = 6 * 60 * 60 * 1000;
  const baseTime = Math.floor(Date.now() / bucketMs) * bucketMs + 4_000;
  const observed = await ingestPhoneNotification(payload({
    eventId: '1'.repeat(64),
    postedAtMs: baseTime,
  }));
  await updatePhoneNotificationSettings({
    mode: 'curated',
    confirmCurated: true,
    replacementScope: 'all_eligible',
    confirmBestEffortReplacement: true,
  });
  const promotedEventId = '2'.repeat(64);
  const promoted = await ingestPhoneNotification(payload({
    eventId: promotedEventId,
    postedAtMs: baseTime + 1_000,
  }));

  assert.equal(promoted.receipt.sourceId, observed.receipt.sourceId);
  assert.equal(promoted.policy.suppressOriginal, true);
  assert.deepEqual(promoted.digest.coveredEventIds, [promotedEventId]);
});

test('dismissed dedupe buckets and exact removal tombstones cannot resurrect', async () => {
  await updatePhoneNotificationSettings({
    mode: 'curated',
    confirmCurated: true,
    replacementScope: 'all_eligible',
    confirmBestEffortReplacement: true,
  });
  const first = await ingestPhoneNotification(payload({
    eventId: '5'.repeat(64),
  }));
  assert.equal(first.receipt.persisted, true);
  const removed = removePhoneNotification('5'.repeat(64));
  assert.equal(removed.resolved, true);
  assert.equal(removed.feedItem?.suggestionStatus, 'dismissed');

  const duplicate = await ingestPhoneNotification(payload({
    eventId: '6'.repeat(64),
    postedAtMs: Date.now() + 1,
  }));
  assert.equal(duplicate.receipt.sourceId, first.receipt.sourceId);
  assert.equal(duplicate.receipt.persisted, false);
  assert.equal(duplicate.policy.suppressOriginal, false);
  assert.equal(duplicate.policy.preserveReason, 'dedupe_tombstoned');
  assert.equal(duplicate.digest.activeCount, 0);
  assert.equal(duplicate.digest.expiresAtMs, null);

  removePhoneNotification('7'.repeat(64));
  const racedIngest = await ingestPhoneNotification(payload({
    eventId: '7'.repeat(64),
    packageName: 'example.raced',
    postedAtMs: Date.now() + 2,
  }));
  assert.equal(racedIngest.receipt.persisted, false);
  assert.equal(racedIngest.policy.preserveReason, 'dedupe_tombstoned');
});

test('category whitespace, controls, case variants, and false native wire proof fail closed', () => {
  for (const category of [
    ' promo',
    'promo ',
    '\tpromo',
    'promo\n',
    'promo\0',
    'recommendation\u0007',
    'Promo',
    'PROMO',
  ]) {
    const classification = classifyPhoneNotification(payload({
      category,
      nativeCategoryWireExact: true,
    }));
    assert.equal(
      classification.protectedFromSuppression,
      true,
      `category variant gained server replacement authority: ${JSON.stringify(category)}`,
    );
  }
  assert.equal(
    classifyPhoneNotification(payload({
      category: 'promo',
      nativeCategoryWireExact: false,
    })).protectedFromSuppression,
    true,
  );
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

test('historical notification scans never refresh source due markers', async () => {
  const result = await ingestPhoneNotification(payload({
    packageName: 'com.reddit.frontpage',
    historical: true,
  }));
  assert.equal(result.receipt.persisted, true);
  assert.equal(result.policy.suppressOriginal, false);
  assert.equal(fs.existsSync(getSourceDueSignalPath('reddit')), false);
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

  assert.deepEqual(synchronizedKinds, ['file', 'file', 'file', 'directory']);
  assert.equal(
    fs.readFileSync(getSourceDueSignalPath('reddit'), 'utf8'),
    SOURCE_DUE_SIGNAL_MARKER,
  );
});

test('source due generation is stamped after the final rename boundary', () => {
  const originalRename = fs.renameSync.bind(fs);
  let browseStartedNs = 0n;
  mock.method(fs, 'renameSync', (oldPath: fs.PathLike, newPath: fs.PathLike) => {
    // Reproduce the bug: a long-lived temp marker predates a browse, while
    // final publication lands after that browse has started.
    fs.utimesSync(oldPath, 1, 1);
    browseStartedNs = BigInt(Date.now()) * 1_000_000n;
    originalRename(oldPath, newPath);
  });

  const signalPath = signalSourceDue('reddit');
  const published = fs.statSync(signalPath, { bigint: true });

  assert.ok(browseStartedNs > 0n);
  assert.ok(
    published.mtimeNs > browseStartedNs,
    'the final marker generation must be newer than a browse already in flight at rename',
  );
  assert.equal(Number(published.mode & 0o777n), 0o600);
});

test('a post-rename stamping failure durably leaves a fail-due pending marker', () => {
  const originalRename = fs.renameSync.bind(fs);
  const originalWrite = fs.writeSync.bind(fs);
  const originalFsync = fs.fsyncSync.bind(fs);
  const synchronizedKinds: string[] = [];
  let published = false;

  mock.method(fs, 'renameSync', (oldPath: fs.PathLike, newPath: fs.PathLike) => {
    originalRename(oldPath, newPath);
    published = true;
  });
  mock.method(
    fs,
    'writeSync',
    (
      descriptor: number,
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number,
    ) => {
      if (published) throw new Error('simulated post-rename write failure');
      return originalWrite(descriptor, buffer, offset, length, position);
    },
  );
  mock.method(fs, 'fsyncSync', (descriptor: number) => {
    synchronizedKinds.push(fs.fstatSync(descriptor).isDirectory() ? 'directory' : 'file');
    originalFsync(descriptor);
  });

  assert.throws(
    () => signalSourceDue('reddit'),
    /simulated post-rename write failure/,
  );

  const signalPath = getSourceDueSignalPath('reddit');
  assert.equal(fs.readFileSync(signalPath, 'utf8'), SOURCE_DUE_SIGNAL_MARKER);
  assert.equal(
    fs.statSync(signalPath).mode & 0o777,
    SOURCE_DUE_SIGNAL_PENDING_MODE,
  );
  assert.deepEqual(
    synchronizedKinds,
    ['file', 'file', 'directory'],
    'the pending inode and its final directory entry remain durable on failure',
  );
  assert.deepEqual(fs.readdirSync(path.dirname(signalPath)), ['reddit.due']);
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
    category: 'msg',
    conversation: true,
    title: 'Private conversation',
    text: 'Private direct message',
  }));
  await ingestPhoneNotification(payload({
    eventId: '8'.repeat(64),
    packageName: 'com.reddit.frontpage',
    appLabel: 'Reader',
    category: 'msg',
    conversation: false,
    title: 'Private direct message',
    text: 'Private direct message body',
  }));
  assert.equal(fs.existsSync(getSourceDueSignalPath('gmail')), false);
  assert.equal(fs.existsSync(getSourceDueSignalPath('twitter')), false);
  assert.equal(fs.existsSync(getSourceDueSignalPath('reddit')), false);
  const browseCacheCount = getDb().prepare(`
    SELECT COUNT(*) AS count
    FROM browse_cache_items
  `).get() as { count: number };
  assert.equal(browseCacheCount.count, 0);
});

test('database startup purges legacy notification content from known agent-evidence stores', () => {
  const privateCanary = 'LEGACY_PRIVATE_NOTIFICATION_CANARY_9182';
  const claudeAppSessionId = '11111111-1111-4111-8111-111111111111';
  const oldClaudeProviderSessionId = '22222222-2222-4222-8222-222222222222';
  const codexAppSessionId = '33333333-3333-4333-8333-333333333333';
  const oldCodexProviderSessionId = '44444444-4444-4444-8444-444444444444';
  const safeAppSessionId = '55555555-5555-4555-8555-555555555555';
  const safeProviderSessionId = '66666666-6666-4666-8666-666666666666';
  const taskLogsDir = path.join(temporaryDataDir, 'task-logs');
  const affectedTaskIds = [
    'task-private-linked',
    'task-private-later',
    'task-private-history-only',
    'task-private-provider-only',
  ];
  const database = getDb();
  database.prepare(`
    INSERT INTO feed (
      id, type, source, source_id, title, text, published_at
    ) VALUES
      (
        'legacy-private-notification', 'notification', 'phone-notification',
        'phone-notification:legacy-private', ?, ?, ?
      ),
      (
        'ordinary-safe-evidence', 'article', 'publisher',
        'publisher:ordinary-safe-evidence', 'Ordinary title', 'Ordinary body', ?
      )
  `).run(
    `Private title ${privateCanary}`,
    `Private body ${privateCanary}`,
    '2026-07-28T12:00:00.000Z',
    '2026-07-28T11:00:00.000Z',
  );
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
  database.prepare(`
    INSERT INTO interactions (feed_item_id, action)
    VALUES
      ('legacy-private-notification', 'expand'),
      ('legacy-private-notification', 'suggestion_dismissed'),
      ('ordinary-safe-evidence', 'expand')
  `).run();
  database.prepare(`
    INSERT INTO feed_engagement_sessions (
      session_id, feed_item_id, item_snapshot
    ) VALUES
      ('legacy:private:engagement', 'legacy-private-notification', ?),
      ('ordinary:safe:engagement', 'ordinary-safe-evidence', ?)
  `).run(
    JSON.stringify({
      type: 'notification',
      source: 'phone-notification',
      title: `Private title ${privateCanary}`,
      text: `Private body ${privateCanary}`,
    }),
    JSON.stringify({
      type: 'article',
      source: 'publisher',
      title: 'Ordinary title',
      text: 'Ordinary body',
    }),
  );
  database.prepare(`
    INSERT INTO preferences (
      id, feed_item_id, signal_type, source, text, source_id
    ) VALUES
      (
        'legacy-private-preference', 'legacy-private-notification',
        'liked', 'app_thumbsup', ?, NULL
      ),
      (
        'legacy-private-orphan-preference', NULL,
        'liked', 'legacy', ?, 'phone-notification:orphan'
      ),
      (
        'ordinary-safe-preference', 'ordinary-safe-evidence',
        'liked', 'app_thumbsup', 'Ordinary preference', NULL
      )
  `).run(
    `Private preference ${privateCanary}`,
    `Private orphan preference ${privateCanary}`,
  );
  database.prepare(`
    INSERT INTO preference_vectors (
      id, text, signal_type, source
    ) VALUES
      ('legacy-private-preference', ?, 'liked', 'app_thumbsup'),
      ('legacy-private-orphan-preference', ?, 'liked', 'legacy'),
      ('ordinary-safe-preference', 'Ordinary preference', 'liked', 'app_thumbsup')
  `).run(
    `Private preference ${privateCanary}`,
    `Private orphan preference ${privateCanary}`,
  );
  database.prepare(`
    INSERT INTO thread_feedback (
      id, thread_id, feed_item_id, vote, thread_title, reason, source_item_ids
    ) VALUES
      (
        'legacy-private-feedback', 'legacy-private-thread',
        'legacy-private-notification', 'more', ?, ?, ?
      ),
      (
        'legacy-private-indirect-feedback', 'legacy-private-indirect-thread',
        'ordinary-safe-evidence', 'more', ?, ?, ?
      ),
      (
        'ordinary-safe-feedback', 'ordinary-safe-thread',
        'ordinary-safe-evidence', 'more', 'Ordinary thread', 'Ordinary reason', ?
      )
  `).run(
    `Private thread ${privateCanary}`,
    `Private reason ${privateCanary}`,
    JSON.stringify(['legacy-private-notification']),
    `Private indirect thread ${privateCanary}`,
    `Private indirect reason ${privateCanary}`,
    JSON.stringify(['legacy-private-notification']),
    JSON.stringify(['ordinary-safe-evidence']),
  );
  database.prepare(`
    INSERT INTO chat_sessions (
      id, provider, provider_session_id, claude_session_id, title, created_at, updated_at
    ) VALUES
      (?, 'claude', ?, ?, 'Legacy private Claude chat', datetime('now'), datetime('now')),
      (?, 'codex', ?, ?, 'Legacy private Codex chat', datetime('now'), datetime('now')),
      (?, 'claude', ?, ?, 'Ordinary safe chat', datetime('now'), datetime('now'))
  `).run(
    claudeAppSessionId,
    oldClaudeProviderSessionId,
    oldClaudeProviderSessionId,
    codexAppSessionId,
    oldCodexProviderSessionId,
    oldCodexProviderSessionId,
    safeAppSessionId,
    safeProviderSessionId,
    safeProviderSessionId,
  );
  database.prepare(`
    INSERT INTO chat_messages (
      id, type, role, in_reply_to, task_id, session_id, text, timestamp,
      context, suggestions, status, metadata
    ) VALUES
      (
        'legacy-private-chat', 'chat', 'user', NULL, NULL, ?, ?, ?,
        ?, ?, 'delivered', ?
      ),
      (
        'legacy-private-linked-reply', 'chat', 'agent',
        'legacy-private-chat', 'task-private-linked', ?, ?, ?,
        ?, ?, 'delivered', ?
      ),
      (
        'legacy-private-follow-up', 'chat', 'user', NULL, NULL, ?,
        'Could you clarify?', ?, NULL, NULL, 'delivered', '{}'
      ),
      (
        'legacy-private-later-reply', 'chat', 'agent',
        'legacy-private-follow-up', 'task-private-later', ?, ?, ?,
        ?, ?, 'delivered', ?
      ),
      (
        'legacy-private-codex-chat', 'chat', 'user', NULL, NULL, ?, ?, ?,
        ?, NULL, 'delivered', ?
      ),
      (
        'ordinary-safe-chat', 'chat', 'user', NULL, NULL, ?,
        'Ordinary question', ?, 'Ordinary context', NULL, 'delivered', ?
      )
  `).run(
    claudeAppSessionId,
    'Chat: What is this?',
    '2026-07-28T12:00:00.000Z',
    'The selected phone notification is a local, model-free card. Its title and body are intentionally unavailable to runtime agents.',
    JSON.stringify([{ label: `Private suggestion ${privateCanary}` }]),
    JSON.stringify({
      contextKind: 'post',
      contextRefId: 'legacy-private-notification',
      phoneNotificationContentWithheld: true,
      legacyPrivateMetadata: privateCanary,
    }),
    claudeAppSessionId,
    `Linked answer derived from ${privateCanary}`,
    '2026-07-28T12:01:00.000Z',
    `Linked context ${privateCanary}`,
    JSON.stringify([{ label: `Linked suggestion ${privateCanary}` }]),
    JSON.stringify({ privateDerivedMetadata: privateCanary }),
    claudeAppSessionId,
    '2026-07-28T12:02:00.000Z',
    claudeAppSessionId,
    `Later answer still derived from ${privateCanary}`,
    '2026-07-28T12:03:00.000Z',
    `Later context ${privateCanary}`,
    JSON.stringify([{ label: `Later suggestion ${privateCanary}` }]),
    JSON.stringify({ privateLaterMetadata: privateCanary }),
    codexAppSessionId,
    `Chat: Preserve this Codex question\n\nContext — discussing this post:\nBody: ${privateCanary}`,
    '2026-07-28T13:00:00.000Z',
    `Codex context ${privateCanary}`,
    JSON.stringify({
      contextKind: 'post',
      contextRefId: 'legacy-private-notification',
      legacyPrivateMetadata: privateCanary,
    }),
    safeAppSessionId,
    '2026-07-28T11:00:00.000Z',
    JSON.stringify({
      contextKind: 'post',
      contextRefId: 'ordinary-safe-evidence',
    }),
  );
  database.prepare(`
    INSERT INTO chat_messages (
      id, type, role, in_reply_to, task_id, session_id, text, timestamp,
      context, suggestions, status, metadata
    ) VALUES
      (
        'current-safe-notification-chat', 'chat', 'user', NULL, NULL, ?,
        'What should I do?', '2026-07-28T14:00:00.000Z', ?, NULL,
        'delivered', ?
      ),
      (
        'current-safe-notification-reply', 'chat', 'agent',
        'current-safe-notification-chat', 'task-current-safe', ?,
        'The private card stayed withheld.', '2026-07-28T14:01:00.000Z',
        NULL, NULL, 'delivered', '{"safeReply":true}'
      )
  `).run(
    safeAppSessionId,
    'The selected phone notification is a local, model-free card. Its title and body are intentionally unavailable to runtime agents.',
    JSON.stringify({
      contextKind: 'post',
      contextRefId: 'legacy-private-notification',
      phoneNotificationContentWithheld: true,
      phoneNotificationSessionEvidencePurged: true,
      phoneNotificationAuditEvidencePurged: true,
      phoneNotificationOrchestratorEvidencePurged: true,
    }),
    safeAppSessionId,
  );
  fs.writeFileSync(
    path.join(temporaryDataDir, 'chat-output.jsonl'),
    [
      {
        type: 'chat',
        id: 'legacy-private-linked-reply',
        role: 'agent',
        inReplyTo: 'legacy-private-chat',
        sessionId: claudeAppSessionId,
        text: `Linked audit answer ${privateCanary}`,
        timestamp: '2026-07-28T12:01:00.000Z',
        metadata: { privateDerivedMetadata: privateCanary },
      },
      {
        type: 'chat',
        id: 'legacy-private-later-reply',
        role: 'agent',
        inReplyTo: 'legacy-private-follow-up',
        sessionId: claudeAppSessionId,
        text: `Later audit answer ${privateCanary}`,
        timestamp: '2026-07-28T12:03:00.000Z',
        metadata: { privateLaterMetadata: privateCanary },
      },
      {
        type: 'chat',
        id: 'ordinary-safe-audit',
        role: 'agent',
        sessionId: safeAppSessionId,
        text: 'Ordinary safe audit reply',
        timestamp: '2026-07-28T11:01:00.000Z',
      },
      {
        type: 'chat',
        id: 'current-safe-notification-reply',
        role: 'agent',
        inReplyTo: 'current-safe-notification-chat',
        sessionId: safeAppSessionId,
        text: 'The private card stayed withheld.',
        timestamp: '2026-07-28T14:01:00.000Z',
      },
    ].map((record) => JSON.stringify(record)).join('\n')
      + `\n{"type":"chat","id":"legacy-private-later-reply","text":"${privateCanary}"\n`,
    'utf8',
  );
  fs.mkdirSync(taskLogsDir, { recursive: true });
  for (const taskId of affectedTaskIds) {
    fs.writeFileSync(
      path.join(taskLogsDir, `${taskId}.jsonl`),
      `${JSON.stringify({ type: 'result', result: `${taskId} ${privateCanary}` })}\n`,
      'utf8',
    );
  }
  fs.writeFileSync(
    path.join(taskLogsDir, 'task-ordinary-safe.jsonl'),
    `${JSON.stringify({ type: 'result', result: 'Ordinary safe task log' })}\n`,
    'utf8',
  );
  const reflectionSession = {
    id: '77777777-7777-4777-8777-777777777777',
    provider: 'claude',
    createdAt: '2026-07-28T00:00:00.000Z',
    trackedFileMtimes: {},
  };
  fs.writeFileSync(
    path.join(temporaryDataDir, 'orchestrator-history.json'),
    JSON.stringify({
      history: [
        {
          id: 'task-private-linked',
          message: `Original prompt ${privateCanary}`,
          response: `Derived response ${privateCanary}`,
          paneTail: privateCanary,
          logFile: path.join(taskLogsDir, 'task-private-linked.jsonl'),
          metadata: {
            chatMessageId: 'legacy-private-chat',
            sessionId: claudeAppSessionId,
            providerSessionId: oldClaudeProviderSessionId,
          },
        },
        {
          id: 'task-private-history-only',
          message: `Later prompt ${privateCanary}`,
          response: `Later response ${privateCanary}`,
          logFile: path.join(taskLogsDir, 'task-private-history-only.jsonl'),
          metadata: {
            chatMessageId: 'legacy-private-follow-up',
            sessionId: claudeAppSessionId,
          },
        },
        {
          id: 'task-private-provider-only',
          message: `Provider-linked prompt ${privateCanary}`,
          logFile: path.join(taskLogsDir, 'task-private-provider-only.jsonl'),
          metadata: {
            providerSessionId: oldCodexProviderSessionId,
          },
        },
        {
          id: 'task-ordinary-safe',
          message: 'Ordinary safe task',
          response: 'Ordinary safe response',
          logFile: path.join(taskLogsDir, 'task-ordinary-safe.jsonl'),
          metadata: {
            chatMessageId: 'ordinary-safe-chat',
            sessionId: safeAppSessionId,
            providerSessionId: safeProviderSessionId,
          },
        },
        {
          id: 'task-current-safe-notification',
          message: 'Current safe notification question',
          response: 'The private card stayed withheld.',
          metadata: {
            chatMessageId: 'current-safe-notification-chat',
            sessionId: safeAppSessionId,
            providerSessionId: safeProviderSessionId,
          },
        },
      ],
      reflectionSession,
    }, null, 2),
    'utf8',
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
  assert.deepEqual(
    reopened.prepare(`
      SELECT feed_item_id, action
      FROM interactions
      ORDER BY feed_item_id, action
    `).all(),
    [
      { feed_item_id: 'legacy-private-notification', action: 'suggestion_dismissed' },
      { feed_item_id: 'ordinary-safe-evidence', action: 'expand' },
    ],
  );
  assert.deepEqual(
    reopened.prepare(`
      SELECT session_id
      FROM feed_engagement_sessions
      ORDER BY session_id
    `).all(),
    [{ session_id: 'ordinary:safe:engagement' }],
  );
  assert.deepEqual(
    reopened.prepare(`SELECT id FROM preferences ORDER BY id`).all(),
    [{ id: 'ordinary-safe-preference' }],
  );
  assert.deepEqual(
    reopened.prepare(`SELECT id FROM preference_vectors ORDER BY id`).all(),
    [{ id: 'ordinary-safe-preference' }],
  );
  assert.deepEqual(
    reopened.prepare(`SELECT id FROM thread_feedback ORDER BY id`).all(),
    [{ id: 'ordinary-safe-feedback' }],
  );

  const privateChat = reopened.prepare(`
    SELECT text, context, metadata
    FROM chat_messages
    WHERE id = 'legacy-private-chat'
  `).get() as { text: string; context: string; metadata: string };
  assert.equal(privateChat.text, 'Chat: What is this?');
  assert.doesNotMatch(`${privateChat.text}\n${privateChat.context}`, new RegExp(privateCanary));
  assert.equal(
    JSON.parse(privateChat.metadata).phoneNotificationContentWithheld,
    true,
  );
  assert.equal(
    JSON.parse(privateChat.metadata).phoneNotificationSessionEvidencePurged,
    true,
  );
  assert.equal(
    JSON.parse(privateChat.metadata).phoneNotificationAuditEvidencePurged,
    true,
  );
  assert.equal(
    JSON.parse(privateChat.metadata).phoneNotificationOrchestratorEvidencePurged,
    true,
  );
  assert.equal(
    (reopened.prepare(`
      SELECT text
      FROM chat_messages
      WHERE id = 'legacy-private-codex-chat'
    `).get() as { text: string }).text,
    'Chat: Preserve this Codex question',
  );
  const derivedReplies = reopened.prepare(`
    SELECT id, text, context, suggestions, metadata
    FROM chat_messages
    WHERE id IN ('legacy-private-linked-reply', 'legacy-private-later-reply')
    ORDER BY id
  `).all() as Array<{
    id: string;
    text: string;
    context: string;
    suggestions: string | null;
    metadata: string;
  }>;
  assert.equal(derivedReplies.length, 2);
  for (const reply of derivedReplies) {
    assert.match(reply.text, /withheld/i);
    assert.match(reply.context, /unavailable/i);
    assert.equal(reply.suggestions, null);
    assert.deepEqual(JSON.parse(reply.metadata), {
      phoneNotificationDerivedContentWithheld: true,
    });
  }
  assert.deepEqual(
    reopened.prepare(`
      SELECT text
      FROM chat_messages
      WHERE id = 'legacy-private-follow-up'
    `).get(),
    { text: 'Could you clarify?' },
  );
  assert.doesNotMatch(
    JSON.stringify(reopened.prepare(`
      SELECT text, context, suggestions, metadata
      FROM chat_messages
    `).all()),
    new RegExp(privateCanary),
  );

  const claudeSession = reopened.prepare(`
    SELECT provider_session_id, claude_session_id
    FROM chat_sessions
    WHERE id = ?
  `).get(claudeAppSessionId) as {
    provider_session_id: string;
    claude_session_id: string;
  };
  assert.match(
    claudeSession.provider_session_id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  assert.notEqual(claudeSession.provider_session_id, oldClaudeProviderSessionId);
  assert.equal(claudeSession.claude_session_id, claudeSession.provider_session_id);
  assert.deepEqual(
    reopened.prepare(`
      SELECT provider_session_id, claude_session_id
      FROM chat_sessions
      WHERE id = ?
    `).get(codexAppSessionId),
    { provider_session_id: '', claude_session_id: '' },
  );
  assert.deepEqual(
    reopened.prepare(`
      SELECT provider_session_id, claude_session_id
      FROM chat_sessions
      WHERE id = ?
    `).get(safeAppSessionId),
    {
      provider_session_id: safeProviderSessionId,
      claude_session_id: safeProviderSessionId,
    },
  );

  const scrubbedAudit = fs.readFileSync(
    path.join(temporaryDataDir, 'chat-output.jsonl'),
    'utf8',
  );
  assert.doesNotMatch(scrubbedAudit, new RegExp(privateCanary));
  assert.doesNotMatch(scrubbedAudit, /legacy-private-(?:linked|later)-reply/);
  assert.match(scrubbedAudit, /ordinary-safe-audit/);
  assert.match(scrubbedAudit, /current-safe-notification-reply/);
  assert.equal(
    fs.statSync(path.join(temporaryDataDir, 'chat-output.jsonl')).mode & 0o777,
    0o600,
  );
  const scrubbedHistory = JSON.parse(
    fs.readFileSync(
      path.join(temporaryDataDir, 'orchestrator-history.json'),
      'utf8',
    ),
  ) as {
    history: Array<{ id: string }>;
    reflectionSession: typeof reflectionSession;
  };
  assert.deepEqual(
    scrubbedHistory.history.map((entry) => entry.id),
    ['task-ordinary-safe', 'task-current-safe-notification'],
  );
  assert.deepEqual(scrubbedHistory.reflectionSession, reflectionSession);
  assert.doesNotMatch(JSON.stringify(scrubbedHistory), new RegExp(privateCanary));
  for (const taskId of affectedTaskIds) {
    assert.equal(
      fs.existsSync(path.join(taskLogsDir, `${taskId}.jsonl`)),
      false,
      `${taskId} log should be removed`,
    );
  }
  assert.equal(
    fs.readFileSync(path.join(taskLogsDir, 'task-ordinary-safe.jsonl'), 'utf8'),
    `${JSON.stringify({ type: 'result', result: 'Ordinary safe task log' })}\n`,
  );
  const safeChat = reopened.prepare(`
    SELECT text, context
    FROM chat_messages
    WHERE id = 'ordinary-safe-chat'
  `).get() as { text: string; context: string };
  assert.deepEqual(safeChat, {
    text: 'Ordinary question',
    context: 'Ordinary context',
  });
  assert.deepEqual(
    reopened.prepare(`
      SELECT text, metadata
      FROM chat_messages
      WHERE id = 'current-safe-notification-reply'
    `).get(),
    {
      text: 'The private card stayed withheld.',
      metadata: '{"safeReply":true}',
    },
  );

  const notificationRow = reopened.prepare(`
    SELECT title, text
    FROM feed
    WHERE id = 'legacy-private-notification'
  `).get() as { title: string; text: string };
  assert.match(`${notificationRow.title}\n${notificationRow.text}`, new RegExp(privateCanary));

  const rotatedClaudeProviderSessionId = claudeSession.provider_session_id;
  closeDatabase();
  const reopenedAgain = getDb();
  assert.equal(
    (reopenedAgain.prepare(`
      SELECT provider_session_id
      FROM chat_sessions
      WHERE id = ?
    `).get(claudeAppSessionId) as { provider_session_id: string }).provider_session_id,
    rotatedClaudeProviderSessionId,
    'the completed migration must not rotate the clean Claude session again',
  );
});

test('runtime-artifact cleanup retries after a durable history rewrite failure', () => {
  const privateCanary = 'LEGACY_RUNTIME_RETRY_CANARY_4176';
  const appSessionId = '88888888-8888-4888-8888-888888888888';
  const providerSessionId = '99999999-9999-4999-8999-999999999999';
  const taskId = 'task-private-retry';
  const historyPath = path.join(temporaryDataDir, 'orchestrator-history.json');
  const taskLogsDir = path.join(temporaryDataDir, 'task-logs');
  const taskLogPath = path.join(taskLogsDir, `${taskId}.jsonl`);
  const database = getDb();

  database.prepare(`
    INSERT INTO feed (
      id, type, source, source_id, title, text, published_at
    ) VALUES (
      'legacy-retry-notification', 'notification', 'phone-notification',
      'phone-notification:legacy-retry', ?, ?, ?
    )
  `).run(privateCanary, privateCanary, '2026-07-28T15:00:00.000Z');
  database.prepare(`
    INSERT INTO chat_sessions (
      id, provider, provider_session_id, claude_session_id, title
    ) VALUES (?, 'claude', ?, ?, 'Retry cleanup')
  `).run(appSessionId, providerSessionId, providerSessionId);
  database.prepare(`
    INSERT INTO chat_messages (
      id, type, role, in_reply_to, task_id, session_id, text, timestamp,
      context, status, metadata
    ) VALUES
      (
        'legacy-retry-root', 'chat', 'user', NULL, NULL, ?,
        'What is this?', '2026-07-28T15:00:00.000Z', ?,
        'delivered', ?
      ),
      (
        'legacy-retry-reply', 'chat', 'agent', 'legacy-retry-root', ?, ?,
        ?, '2026-07-28T15:01:00.000Z', ?, 'delivered', ?
      )
  `).run(
    appSessionId,
    privateCanary,
    JSON.stringify({
      contextKind: 'post',
      contextRefId: 'legacy-retry-notification',
    }),
    taskId,
    appSessionId,
    privateCanary,
    privateCanary,
    JSON.stringify({ privateCanary }),
  );
  fs.mkdirSync(taskLogsDir, { recursive: true });
  fs.writeFileSync(taskLogPath, `${privateCanary}\n`, 'utf8');
  fs.writeFileSync(
    historyPath,
    JSON.stringify({
      history: [{
        id: taskId,
        message: privateCanary,
        response: privateCanary,
        logFile: taskLogPath,
        metadata: {
          chatMessageId: 'legacy-retry-root',
          sessionId: appSessionId,
          providerSessionId,
        },
      }],
      reflectionSession: null,
    }),
    'utf8',
  );
  closeDatabase();

  const originalRename = fs.renameSync.bind(fs);
  mock.method(fs, 'renameSync', (oldPath: fs.PathLike, newPath: fs.PathLike) => {
    if (newPath === historyPath) {
      throw new Error('simulated history rewrite failure');
    }
    return originalRename(oldPath, newPath);
  });

  assert.throws(() => getDb(), /simulated history rewrite failure/);
  assert.equal(fs.existsSync(taskLogPath), false);
  assert.match(fs.readFileSync(historyPath, 'utf8'), new RegExp(privateCanary));
  closeDatabase();
  const rawDatabase = new Database(path.join(temporaryDataDir, 'media-agent.db'));
  try {
    const failedMetadata = rawDatabase.prepare(`
      SELECT metadata
      FROM chat_messages
      WHERE id = 'legacy-retry-root'
    `).get() as { metadata: string };
    assert.equal(
      JSON.parse(failedMetadata.metadata).phoneNotificationOrchestratorEvidencePurged,
      undefined,
      'failed durable cleanup must roll back its root marker',
    );
  } finally {
    rawDatabase.close();
  }
  mock.restoreAll();

  const retried = getDb();
  assert.doesNotMatch(fs.readFileSync(historyPath, 'utf8'), new RegExp(privateCanary));
  const rootMetadata = retried.prepare(`
    SELECT metadata
    FROM chat_messages
    WHERE id = 'legacy-retry-root'
  `).get() as { metadata: string };
  assert.equal(
    JSON.parse(rootMetadata.metadata).phoneNotificationOrchestratorEvidencePurged,
    true,
  );
});

test('malformed orchestrator history is reset and Evogent task logs fail closed', () => {
  const privateCanary = 'MALFORMED_RUNTIME_HISTORY_CANARY_6248';
  const historyPath = path.join(temporaryDataDir, 'orchestrator-history.json');
  const taskLogsDir = path.join(temporaryDataDir, 'task-logs');
  const database = getDb();

  database.prepare(`
    INSERT INTO feed (
      id, type, source, source_id, title, text, published_at
    ) VALUES (
      'malformed-history-notification', 'notification', 'phone-notification',
      'phone-notification:malformed-history', ?, ?, ?
    )
  `).run(privateCanary, privateCanary, '2026-07-28T16:00:00.000Z');
  database.prepare(`
    INSERT INTO chat_messages (
      id, type, role, session_id, text, timestamp, context, status, metadata
    ) VALUES (
      'malformed-history-root', 'chat', 'user',
      'malformed-history-session', 'What is this?',
      '2026-07-28T16:00:00.000Z', ?, 'delivered', ?
    )
  `).run(
    privateCanary,
    JSON.stringify({
      contextKind: 'post',
      contextRefId: 'malformed-history-notification',
    }),
  );
  fs.mkdirSync(taskLogsDir, { recursive: true });
  fs.writeFileSync(
    path.join(taskLogsDir, 'possibly-private.jsonl'),
    `${privateCanary}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(taskLogsDir, 'otherwise-unrelated.jsonl'),
    'unclassifiable diagnostic\n',
    'utf8',
  );
  fs.writeFileSync(
    historyPath,
    `{"history":[{"message":"${privateCanary}"}`,
    'utf8',
  );
  closeDatabase();

  const reopened = getDb();
  assert.deepEqual(
    JSON.parse(fs.readFileSync(historyPath, 'utf8')),
    { history: [], reflectionSession: null },
  );
  assert.deepEqual(
    fs.readdirSync(taskLogsDir).filter((entry) => entry.endsWith('.jsonl')),
    [],
  );
  const rootMetadata = reopened.prepare(`
    SELECT metadata
    FROM chat_messages
    WHERE id = 'malformed-history-root'
  `).get() as { metadata: string };
  assert.equal(
    JSON.parse(rootMetadata.metadata).phoneNotificationOrchestratorEvidencePurged,
    true,
  );
});

test('settings view exposes observed apps and immutable safeguards without notification content', async () => {
  await ingestPhoneNotification(payload());
  const view = await getPhoneNotificationSettingsView();
  assert.equal(view.observedApps.length, 1);
  assert.equal(view.observedApps[0].label, 'Reader');
  assert.equal(view.observedApps[0].replacementAllowed, false);
  assert.equal(view.safeguards.observeIsDefault, true);
  assert.equal(view.safeguards.originalsPreservedByDefault, true);
  assert.equal(view.safeguards.replacementScopeIsExplicit, true);
  assert.equal(view.safeguards.preservedPackagesOverrideScope, true);
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
