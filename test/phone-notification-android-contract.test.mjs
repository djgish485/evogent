import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const listener = fs.readFileSync(
  'android-shell/src/net/dangish/evogent/EvogentNotificationListenerService.java',
  'utf8',
);
const nativePolicy = fs.readFileSync(
  'android-shell/src/net/dangish/evogent/EvogentNotificationPolicy.java',
  'utf8',
);
const mainActivity = fs.readFileSync(
  'android-shell/src/net/dangish/evogent/MainActivity.java',
  'utf8',
);
const manifest = fs.readFileSync('android-shell/AndroidManifest.xml', 'utf8');
const settingsPanel = fs.readFileSync(
  'src/components/phone-notification-curation-panel.tsx',
  'utf8',
);
const architecture = fs.readFileSync('docs/phone-notification-curation.md', 'utf8');
const architectureProse = architecture.replace(/\s+/g, ' ');
const listenerWithoutComments = listener
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '');

test('notification listener work is bounded and never reads action/message payloads', () => {
  assert.match(listener, /MAX_PENDING_EVENTS\s*=\s*128/);
  assert.match(listener, /ArrayBlockingQueue<Runnable>/);
  assert.match(listener, /DiscardOldestPolicy/);
  assert.match(listener, /original preserved/);
  assert.doesNotMatch(
    listenerWithoutComments,
    /\.actions\b|EXTRA_MESSAGES|getParcelableArray|RemoteViews/,
  );
  assert.match(listener, /EvogentNotificationPolicy\.EVOGENT_PACKAGE\.equals/);
});

test('native replacement binds an exact durable receipt, active digest, and current generation', () => {
  assert.match(listener, /postJsonDirectForJson/);
  assert.match(listener, /publishAndVerifyDigest/);
  assert.match(listener, /evogent_event_id/);
  assert.match(listener, /isDigestActive\(eventId\)/);
  assert.match(listener, /isSameActiveRevision/);
  assert.match(listener, /shouldCancelOriginal/);
  assert.match(nativePolicy, /expectedEventId\.equals\(receiptEventId\)/);
  assert.match(nativePolicy, /receiptPersisted/);
  assert.match(nativePolicy, /"curated"\.equals\(serverMode\)/);
  assert.match(nativePolicy, /digestActive/);
  assert.match(nativePolicy, /activeRevisionMatches/);
  assert.match(nativePolicy, /postTimeMs/);
});

test('known secrets are removed before native request fields are populated', () => {
  assert.match(nativePolicy, /verification code/);
  assert.match(nativePolicy, /VISIBILITY_SECRET/);
  assert.match(nativePolicy, /redact \? null : input\.title/);
  assert.match(nativePolicy, /redact \? null : input\.text/);
  assert.match(listener, /decision\.safeTitle/);
  assert.match(listener, /decision\.safeText/);
  assert.doesNotMatch(listener, /request\.put\("title", title\)/);
  assert.doesNotMatch(listener, /request\.put\("text", text\)/);
});

test('Android notification permission is contextual and one-shot', () => {
  assert.match(manifest, /android\.permission\.POST_NOTIFICATIONS/);
  assert.match(mainActivity, /maybeRequestNotificationPermissionOnce/);
  assert.match(mainActivity, /webView == null/);
  assert.match(mainActivity, /isNotificationListenerAccessGranted/);
  assert.match(mainActivity, /NOTIFICATION_PERMISSION_ASKED_KEY/);
  assert.match(mainActivity, /\.commit\(\)/);
  assert.doesNotMatch(mainActivity, /shouldShowRequestPermissionRationale/);
});

test('accessible UI exposes reversible modes, lock-screen privacy, and per-app preservation', () => {
  assert.match(settingsPanel, /aria-pressed/);
  assert.match(settingsPanel, /Observe/);
  assert.match(settingsPanel, /Curated shade/);
  assert.match(settingsPanel, /Paused/);
  assert.match(settingsPanel, /Private \(recommended\)/);
  assert.match(settingsPanel, /role="radiogroup"/);
  assert.match(settingsPanel, /Always keep originals from these apps/);
  assert.match(settingsPanel, /reversible/i);
});

test('public architecture does not overclaim Android lock-screen authority', () => {
  assert.match(architectureProse, /cannot:.*replace the Android lock screen/i);
  assert.match(architectureProse, /after a notification is posted/i);
  assert.match(architectureProse, /At a Glance/i);
  assert.match(architectureProse, /media controls/i);
  assert.match(architectureProse, /an eligible original.*appearing briefly/i);
});
