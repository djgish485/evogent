import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const listener = fs.readFileSync(
  'android-shell/src/net/dangish/evogent/EvogentNotificationListenerService.java',
  'utf8',
);
const workQueue = fs.readFileSync(
  'android-shell/src/net/dangish/evogent/EvogentNotificationWorkQueue.java',
  'utf8',
);
const loopbackAuth = fs.readFileSync(
  'android-shell/src/net/dangish/evogent/EvogentLoopbackAuth.java',
  'utf8',
);
const shareReceiver = fs.readFileSync(
  'android-shell/src/net/dangish/evogent/ShareReceiverActivity.java',
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
const notificationCuration = fs.readFileSync(
  'src/lib/phone-notification-curation.ts',
  'utf8',
);
const architecture = fs.readFileSync('docs/phone-notification-curation.md', 'utf8');
const architectureProse = architecture.replace(/\s+/g, ' ');
const listenerWithoutComments = listener
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '');

test('notification listener work is bounded and never reads action/message payloads', () => {
  assert.match(listener, /MAX_LIVE_PENDING_EVENTS\s*=\s*16/);
  assert.match(listener, /MAX_HISTORICAL_PENDING_EVENTS\s*=\s*128/);
  assert.match(listener, /EvogentNotificationWorkQueue<StatusBarNotification>/);
  assert.match(workQueue, /ArrayDeque<Entry<T>> live/);
  assert.match(workQueue, /ArrayDeque<Entry<T>> historical/);
  assert.match(
    workQueue,
    /inFlight\s*=\s*!live\.isEmpty\(\)\s*\?\s*live\.removeLast\(\)\s*:\s*historical\.removeFirst\(\)/,
  );
  assert.match(workQueue, /live\.removeFirst\(\)/);
  assert.match(workQueue, /REPLACED_PENDING_REVISION/);
  assert.match(workQueue, /liveSequence/);
  assert.match(workQueue, /hasNewerRevision/);
  assert.match(workQueue, /boolean isCurrent\(Entry<T> entry\)/);
  assert.match(workQueue, /supersededByNewerRevision/);
  assert.match(workQueue, /void complete\(Entry<T> entry\)[\s\S]*?inFlight = null/);
  assert.match(listener, /finally \{[\s\S]*?workQueue\.complete\(entry\)/);
  assert.match(listener, /notification\.getKey\(\)/);
  assert.match(
    listener,
    /private void enqueue[\s\S]*?EVOGENT_PACKAGE\.equals\(packageName\)\) return;[\s\S]*?workQueue\.offer/,
  );
  assert.match(listener, /wouldRegressAppliedLiveDigest/);
  assert.match(listener, /markLiveDigestApplied/);
  assert.match(
    listener,
    /if \(!isPublicationCurrent\(entry, snapshot\)\) return;[\s\S]*?publishAndVerifyDigest/,
  );
  assert.match(
    listener,
    /isPublicationCurrent[\s\S]*?isCurrentWork\(entry\)[\s\S]*?isSameActiveRevision\(snapshot\)/,
  );
  assert.match(listener, /original preserved/);
  assert.doesNotMatch(
    listenerWithoutComments,
    /\.actions\b|EXTRA_MESSAGES|getParcelableArray|RemoteViews/,
  );
  assert.match(listener, /EvogentNotificationPolicy\.EVOGENT_PACKAGE\.equals/);
});

test('live notification lane uses one monotonic network deadline without changing share/web defaults', () => {
  assert.match(listener, /NOTIFICATION_NETWORK_BUDGET_MS\s*=\s*2000/);
  assert.match(
    listener,
    /SystemClock\.elapsedRealtime\(\)\s*\+\s*NOTIFICATION_NETWORK_BUDGET_MS/,
  );
  assert.match(listener, /postJsonDirectForJsonBefore/);
  assert.match(loopbackAuth, /requireRemainingDeadlineMs/);
  assert.match(loopbackAuth, /readBoundedBefore/);
  assert.match(
    loopbackAuth,
    /setReadTimeout\(requireRemainingDeadlineMs\([\s\S]*?input\.read\(buffer\)/,
  );
  assert.match(loopbackAuth, /MIN_DIRECT_RETRY_REMAINING_MS\s*=\s*300/);
  assert.match(loopbackAuth, /direct_retry_budget_exhausted/);
  assert.match(loopbackAuth, /DEFAULT_AUTH_STAGE_TIMEOUT_MS\s*=\s*6000/);
  assert.match(loopbackAuth, /authenticate\(context, sessionKind, DEFAULT_AUTH_STAGE_TIMEOUT_MS\)/);
  assert.match(shareReceiver, /postJsonDirect\([\s\S]*?8000,\s*8000\)/);
  assert.match(architectureProse, /Live `onNotificationPosted` callbacks always leapfrog reconnect history/);
  assert.match(architectureProse, /newest pending live callback is always selected next/);
  assert.match(architectureProse, /Historical completeness is best-effort/);
  assert.match(architectureProse, /make that source due in the next normal scheduler-owned cycle/);
  assert.match(architectureProse, /A push does not start its own cycle or model call/);
});

test('best-effort native replacement requires per-package permission and generation-owned digest work', () => {
  assert.match(listener, /postJsonDirectForJsonBefore/);
  assert.match(listener, /publishAndVerifyDigest/);
  assert.match(listener, /DIGEST_PUBLICATION_LOCK/);
  assert.match(listener, /activeServiceGeneration/);
  assert.match(listener, /DIGEST_SERVICE_GENERATION_EXTRA/);
  assert.match(listener, /DIGEST_WORK_SEQUENCE_EXTRA/);
  assert.match(listener, /isPublicationCurrent/);
  assert.match(listener, /retractDigestIfOwned/);
  assert.match(listener, /isDigestActive\(marker\)/);
  assert.match(listener, /isSameActiveRevision/);
  assert.match(listener, /shouldCancelOriginal/);
  assert.match(listener, /policy\.optBoolean\("replacementAllowed", false\)/);
  assert.match(nativePolicy, /expectedEventId\.equals\(receiptEventId\)/);
  assert.match(nativePolicy, /receiptPersisted/);
  assert.match(nativePolicy, /"curated"\.equals\(serverMode\)/);
  assert.match(nativePolicy, /&& replacementAllowed/);
  assert.match(nativePolicy, /digestActive/);
  assert.match(nativePolicy, /activeRevisionMatches/);
  assert.match(nativePolicy, /postTimeMs/);
  assert.match(nativePolicy, /Integer\.toString\(input\.importance\)/);
  assert.match(nativePolicy, /Boolean\.toString\(input\.clearable\)/);
  assert.match(listener, /current\.decision\.nativeCanSuppress/);
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

test('accessible UI exposes default preservation and explicit reversible best-effort replacement', () => {
  assert.match(settingsPanel, /aria-pressed/);
  assert.match(settingsPanel, /Observe/);
  assert.match(settingsPanel, /Curated shade/);
  assert.match(settingsPanel, /Paused/);
  assert.match(settingsPanel, /Private \(recommended\)/);
  assert.match(settingsPanel, /role="radiogroup"/);
  assert.match(settingsPanel, /Always keep originals from these apps/);
  assert.match(settingsPanel, /Allow best-effort replacement for these apps/);
  assert.match(settingsPanel, /aria-describedby/);
  assert.match(settingsPanel, /Android only permits[\s\S]*?notification key/);
  assert.match(settingsPanel, /same-key update can[\s\S]*?race the final check/);
  assert.match(settingsPanel, /confirmBestEffortReplacement/);
  assert.match(settingsPanel, /reversible/i);
  assert.match(notificationCuration, /replacementPackages:\s*\[\]/);
  assert.match(notificationCuration, /app_not_replacement_allowed/);
  assert.match(notificationCuration, /replacementAllowed/);
});

test('public architecture does not overclaim Android lock-screen or cancellation authority', () => {
  assert.match(architectureProse, /cannot:.*replace the Android lock screen/i);
  assert.match(architectureProse, /after a notification is posted/i);
  assert.match(architectureProse, /At a Glance/i);
  assert.match(architectureProse, /media controls/i);
  assert.match(architectureProse, /an eligible original.*appearing briefly/i);
  assert.match(architectureProse, /key-only cancellation race/i);
  assert.match(architectureProse, /no atomic.*cancel only if this version still matches/i);
  assert.doesNotMatch(architectureProse, /cancels only an exact match/i);
});
