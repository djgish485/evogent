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
const receiptStore = fs.readFileSync(
  'android-shell/src/net/dangish/evogent/EvogentNotificationReceiptStore.java',
  'utf8',
);
const receiptRetentionPolicy = fs.readFileSync(
  'android-shell/src/net/dangish/evogent/EvogentNotificationReceiptRetentionPolicy.java',
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
const phoneUi = fs.readFileSync('src/app/page.tsx', 'utf8');
const notificationCuration = fs.readFileSync(
  'src/lib/phone-notification-curation.ts',
  'utf8',
);
const architecture = fs.readFileSync('docs/phone-notification-curation.md', 'utf8');
const architectureProse = architecture.replace(/\s+/g, ' ');
const efficiency = fs.readFileSync(
  'docs/phone-efficiency-and-model-routing.md',
  'utf8',
);
const production = fs.readFileSync('docs/phone-production.md', 'utf8');
const auditCore = fs.readFileSync('.claude/shared/audit-core.md', 'utf8');
const runtimePrivacyProse = [
  architecture,
  efficiency,
  production,
  auditCore,
].join('\n').replace(/\s+/g, ' ');
const listenerWithoutComments = listener
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '');

test('notification listener work is bounded and never reads action/message payloads', () => {
  assert.match(listener, /MAX_LIVE_PENDING_EVENTS\s*=\s*16/);
  assert.match(listener, /MAX_HISTORICAL_PENDING_EVENTS\s*=\s*128/);
  assert.match(listener, /EvogentNotificationWorkQueue<NotificationWork>/);
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
  assert.match(workQueue, /int retire\(String key\)/);
  assert.match(workQueue, /!entry\.retired/);
  assert.match(workQueue, /supersededByNewerRevision/);
  assert.match(workQueue, /void complete\(Entry<T> entry\)[\s\S]*?inFlight = null/);
  assert.match(listener, /finally \{[\s\S]*?workQueue\.complete\(entry\)/);
  assert.match(listener, /notification\.getKey\(\)/);
  assert.match(
    listener,
    /private void enqueue[\s\S]*?EVOGENT_PACKAGE\.equals\(packageName\)\) return;[\s\S]*?workQueue\.offer/,
  );
  assert.match(listener, /mayCancelFromLiveSequence/);
  assert.doesNotMatch(listener, /newestAppliedLiveDigestSequence/);
  assert.match(
    nativePolicy,
    /return !historical && workSequence > 0L/,
  );
  assert.match(
    listener,
    /if \(!isPublicationCurrent\(entry, snapshot\)\) return;[\s\S]*?publishAndVerifyDigest/,
  );
  assert.match(
    listener,
    /isPublicationCurrent[\s\S]*?isCurrentWork\(entry\)[\s\S]*?isSameActiveRevision\(snapshot\)/,
  );
  assert.doesNotMatch(
    listener.match(
      /private boolean isPublicationCurrent[\s\S]*?\n    }\n/,
    )?.[0] ?? '',
    /mayCancelFromLiveSequence/,
  );
  assert.match(listener, /original preserved/);
  assert.doesNotMatch(
    listenerWithoutComments,
    /\.actions\b|EXTRA_MESSAGES|getParcelableArray|RemoteViews/,
  );
  assert.match(listener, /EvogentNotificationPolicy\.EVOGENT_PACKAGE\.equals/);
});

test('live notification lane uses one bounded end-to-end deadline without changing share/web defaults', () => {
  assert.match(listener, /NOTIFICATION_END_TO_END_BUDGET_MS\s*=\s*2000/);
  const nativeBudgetMs = Number(
    listener.match(/NOTIFICATION_END_TO_END_BUDGET_MS\s*=\s*(\d+)/)?.[1],
  );
  const serverBudgetMs = Number(
    notificationCuration.match(
      /PHONE_NOTIFICATION_NATIVE_END_TO_END_BUDGET_MS\s*=\s*(\d+)/,
    )?.[1],
  );
  assert.equal(serverBudgetMs, nativeBudgetMs);
  assert.match(
    notificationCuration,
    /PHONE_NOTIFICATION_AUTHORITY_REVOCATION_DRAIN_MS\s*=\s*[\s\S]*?PHONE_NOTIFICATION_NATIVE_END_TO_END_BUDGET_MS\s*\+\s*1/,
  );
  assert.match(
    notificationCuration,
    /didPhoneNotificationReplacementAuthorityDecrease[\s\S]*?waitForPhoneNotificationAuthorityRevocationDrain/,
  );
  assert.match(
    listener,
    /SystemClock\.elapsedRealtime\(\)\s*\+\s*NOTIFICATION_END_TO_END_BUDGET_MS/,
  );
  assert.match(listener, /Math\.min\([\s\S]*?endToEndDeadlineElapsedMs/);
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
  assert.match(notificationCuration, /setImmediate\(/);
  assert.match(
    notificationCuration,
    /schedulePhoneNotificationFeedUpdate\(result\.feedItem\)/,
  );
  assert.match(architectureProse, /Live `onNotificationPosted` callbacks always leapfrog reconnect history/);
  assert.match(architectureProse, /newest pending live callback is always selected next/);
  assert.match(architectureProse, /Historical completeness is best-effort/);
  assert.match(architectureProse, /compares its modification time with a separate per-source acknowledgement/);
  assert.match(architectureProse, /never enters the browse cache or another model-facing candidate store/);
  assert.match(architectureProse, /A push does not start its own cycle or model call/);
});

test('best-effort native replacement requires durable private receipt and generation-owned digest work', () => {
  assert.match(listener, /postJsonDirectForJsonBefore/);
  assert.match(listener, /publishAndVerifyDigest/);
  assert.match(listener, /DIGEST_PUBLICATION_LOCK/);
  assert.match(listener, /activeServiceGeneration/);
  assert.match(listener, /DIGEST_SERVICE_GENERATION_EXTRA/);
  assert.match(listener, /DIGEST_WORK_SEQUENCE_EXTRA/);
  assert.match(listener, /DIGEST_COVERED_EVENT_IDS_EXTRA/);
  assert.match(listener, /DIGEST_ACTIVE_COUNT_EXTRA/);
  assert.match(listener, /DIGEST_EXPIRES_AT_MS_EXTRA/);
  assert.match(listener, /activeCount != marker\.coveredEventIds\.size\(\)/);
  assert.match(listener, /values == null \|\| values\.isEmpty\(\)/);
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
  assert.match(nativePolicy, /digestTimeoutAfterMs/);
  assert.match(nativePolicy, /MAX_DIGEST_TIMEOUT_MS/);
  assert.match(listener, /current\.decision\.nativeCanSuppress/);
  assert.match(
    listener,
    /replacementPolicyCandidate = !entry\.historical[\s\S]*?coveredEventIds\.contains\(snapshot\.eventId\)[\s\S]*?store\.recordReceipt/,
  );
  assert.match(listener, /markCancellationPending/);
  assert.match(receiptStore, /getNoBackupFilesDir/);
  assert.match(receiptStore, /output\.getFD\(\)\.sync\(\)/);
  assert.doesNotMatch(receiptStore, /"title"|"text"|"subText"|"appLabel"/);
});

test('native removal and UI dismissal remain exact, bounded, and fail closed', () => {
  assert.match(listener, /onNotificationRemoved/);
  assert.match(listener, /NotificationListenerService\.REASON_LISTENER_CANCEL/);
  assert.match(
    listener,
    /store\.markRemoved\(record\.eventId, listenerCancellation\)/,
  );
  assert.match(listener, /workQueue\.retire\(key\)/);
  assert.match(listener, /PHONE_NOTIFICATION_REMOVE_URL/);
  assert.match(listener, /REMOVAL_NETWORK_BUDGET_MS\s*=\s*750/);
  assert.match(listener, /requestUserDismiss/);
  assert.match(listener, /hasActiveDigestCovering/);
  assert.match(listener, /pendingRemovalEventIds/);
  assert.match(listener, /pendingUserDismissEventIds/);
  assert.match(listener, /pendingCuratedCancellationEventIds/);
  assert.match(listener, /pruneActiveDigestCoverage/);
  assert.match(listener, /pruneResolvedLifecycleCoverage/);
  assert.match(listener, /reconcilePendingUserDismissals/);
  assert.match(listener, /reconcilePendingCuratedCancellations/);
  assert.match(listener, /rebindActiveDigestGeneration/);
  assert.match(receiptStore, /STATE_REMOVAL_PENDING/);
  assert.match(receiptStore, /STATE_USER_DISMISS_PENDING/);
  assert.match(receiptStore, /STATE_CURATED_REMOVED/);
  assert.match(receiptStore, /STATE_USER_DISMISSED/);
  assert.match(receiptStore, /STATE_EXTERNAL_REMOVED/);
  assert.match(
    receiptRetentionPolicy,
    /listenerCancellation && "curated_cancel_pending"\.equals\(state\)/,
  );
  assert.match(receiptStore, /resolvedLifecycleEventIds/);
  assert.match(listener, /store\.markUserDismissPending\(eventId\)/);
  assert.match(listener, /store\.markUserDismissResolved\(eventId\)/);
  assert.match(receiptStore, /EvogentNotificationReceiptRetentionPolicy\.priority/);
  assert.match(
    receiptRetentionPolicy,
    /"removal_pending"\.equals\(state\)[\s\S]*?"curated_cancel_pending"\.equals\(state\)[\s\S]*?return 0/,
  );
  assert.match(
    receiptRetentionPolicy,
    /"receipt"\.equals\(state\) \|\| "curated_removed"\.equals\(state\)[\s\S]*?return 1/,
  );
  assert.match(receiptRetentionPolicy, /"observed"/);
  assert.match(mainActivity, /dismissPhoneNotification/);
  assert.match(phoneUi, /\/api\/internal\/phone-notifications\/remove/);
  assert.match(phoneUi, /hasExactPhoneReceipt/);
  assert.match(notificationCuration, /dedupe_tombstoned/);
  assert.match(notificationCuration, /phone_notification_tombstones/);
  assert.match(
    notificationCuration,
    /removeAndNotifyPhoneNotification[\s\S]*?schedulePhoneNotificationFeedUpdate/,
  );
  const appliedDigest = listener.indexOf('digestActive = publishAndVerifyDigest(');
  const postPublicationPrune = listener.indexOf(
    'pruneResolvedLifecycleCoverage();',
    appliedDigest,
  );
  const cancellationDecision = listener.indexOf(
    'boolean cancellationSequenceCurrent',
    appliedDigest,
  );
  assert.ok(appliedDigest >= 0);
  assert.ok(postPublicationPrune > appliedDigest);
  assert.ok(cancellationDecision > postPublicationPrune);
  assert.match(
    listener,
    /store\.acknowledgeRemoval\(entry\.value\.removedEventId\)[\s\S]*?pruneActiveDigestCoverage\(entry\.value\.removedEventId\)/,
  );
});

test('digest is aggregate, silent, low-importance, and opens the notification view', () => {
  assert.match(notificationCuration, /buildPhoneNotificationDigest/);
  assert.match(notificationCuration, /coveredEventIds/);
  assert.match(notificationCuration, /expiresAtMs:\s*number \| null/);
  assert.match(notificationCuration, /Math\.min\(earliest, Date\.parse\(row\.expires_at\)\)/);
  assert.match(notificationCuration, /expiresAtMs:\s*null/);
  assert.match(listener, /evogent_curated_notifications_v2_silent/);
  assert.match(listener, /IMPORTANCE_LOW/);
  assert.match(listener, /\.setPriority\(Notification\.PRIORITY_LOW\)/);
  assert.match(listener, /\.setSound\(null/);
  assert.match(listener, /\.setVibrate\(null\)/);
  assert.match(listener, /\.setAutoCancel\(false\)/);
  assert.ok(
    (listener.match(/\.setTimeoutAfter\(/g) ?? []).length >= 3,
    'initial publication, generation rebind, and lifecycle prune must restore the timeout',
  );
  assert.match(
    listener,
    /if \(Build\.VERSION\.SDK_INT < 26\) return false/,
  );
  assert.match(listener, /raw instanceof Number/);
  assert.match(
    listener,
    /timeoutAfterMs <= NOTIFICATION_END_TO_END_BUDGET_MS/,
  );
  assert.match(
    listener,
    /marker\.expiresAtMs == candidate\.getNotification\(\)\.extras\.getLong\([\s\S]*?DIGEST_EXPIRES_AT_MS_EXTRA/,
  );
  assert.match(listener, /OPEN_NOTIFICATIONS_EXTRA/);
  assert.match(mainActivity, /evogent:open-notifications/);
  assert.match(phoneUi, /setSelectedFilter\('notification'\)/);
  assert.match(architectureProse, /earliest expiry among exactly those covered rows/);
  assert.match(architectureProse, /recompute the remaining Android timeout/);
  assert.match(architectureProse, /never extend it/);
});

test('known secrets are removed before native request fields are populated', () => {
  assert.match(nativePolicy, /verification code/);
  assert.match(nativePolicy, /VISIBILITY_SECRET/);
  assert.match(nativePolicy, /redact \? null : input\.title/);
  assert.match(nativePolicy, /redact \? null : input\.text/);
  assert.match(
    nativePolicy,
    /identityDecision\.redactContent \? "\[redacted\]" : input\.text/,
  );
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
  assert.match(settingsPanel, /Eligible low-stakes replacement scope/);
  assert.match(settingsPanel, /All eligible low-stakes apps/);
  assert.match(settingsPanel, /aria-describedby/);
  assert.match(settingsPanel, /Android only permits[\s\S]*?notification key/);
  assert.match(settingsPanel, /same-key update can[\s\S]*?race the final check/);
  assert.match(settingsPanel, /confirmBestEffortReplacement/);
  assert.match(settingsPanel, /reversible/i);
  assert.match(notificationCuration, /replacementPackages:\s*\[\]/);
  assert.match(notificationCuration, /replacementScope:\s*'per_app'/);
  assert.match(notificationCuration, /preservedPackages\.includes/);
  assert.match(notificationCuration, /app_not_replacement_allowed/);
  assert.match(notificationCuration, /replacementAllowed/);
});

test('Phone Alerts exposes a fail-safe native capability recovery state', () => {
  assert.match(mainActivity, /getNotificationCapability:function\(\)/);
  assert.match(mainActivity, /openNotificationListenerSettings:function\(\)/);
  assert.match(mainActivity, /openNotificationSettings:function\(\)/);
  assert.match(
    mainActivity,
    /isHomeSurface\(\)[\s\S]{0,100}"getNotificationCapability"\.equals\(method\)/,
  );
  assert.match(
    mainActivity,
    /isHomeSurface\(\)[\s\S]{0,100}"openNotificationSettings"\.equals\(method\)/,
  );
  assert.match(
    mainActivity,
    /isHomeSurface\(\)[\s\S]{0,100}"openNotificationListenerSettings"\.equals\(method\)/,
  );
  const boundEscapeBlock = mainActivity.match(
    /boolean assistantEscapeOperation =[\s\S]*?;\s*boolean validOperation =/,
  )?.[0] ?? '';
  assert.match(boundEscapeBlock, /assistantPrompt/);
  assert.match(boundEscapeBlock, /"close"\.equals\(method\)/);
  assert.match(boundEscapeBlock, /"openApp"\.equals\(method\)/);
  assert.match(boundEscapeBlock, /"openAndroidHome"\.equals\(method\)/);
  assert.doesNotMatch(
    boundEscapeBlock,
    /getNotificationCapability|openNotificationSettings|openNotificationListenerSettings/,
  );
  const boundCapabilityBlock = mainActivity.match(
    /boolean boundCapabilityReadOperation =[\s\S]*?;\s*boolean boundDocumentOperation =/,
  )?.[0] ?? '';
  assert.match(boundCapabilityBlock, /"getNotificationCapability"\.equals\(method\)/);
  assert.doesNotMatch(
    boundCapabilityBlock,
    /openNotificationSettings|openNotificationListenerSettings/,
  );
  assert.match(
    mainActivity,
    /boolean boundDocumentOperation =\s*boundEscapeOperation \|\| boundCapabilityReadOperation[\s\S]*?boolean authorizedOperation = boundDocumentOperation[\s\S]{0,120}: authorizeCurrentDocumentForNativeAction\(\)/,
  );
  assert.match(mainActivity, /Settings\.ACTION_APP_NOTIFICATION_SETTINGS/);
  assert.match(mainActivity, /Settings\.ACTION_NOTIFICATION_LISTENER_SETTINGS/);
  assert.match(mainActivity, /Settings\.EXTRA_APP_PACKAGE/);
  assert.match(mainActivity, /Settings\.ACTION_APPLICATION_DETAILS_SETTINGS/);
  assert.match(mainActivity, /result\.confirm\(openNotificationListenerSettings\(\)\)/);
  assert.match(mainActivity, /\.put\("digestSupported", digestSupported\)/);
  assert.match(mainActivity, /\.put\("listenerAccessGranted", listenerAccessGranted\)/);
  assert.match(mainActivity, /\.put\("postingPermissionGranted", postingPermissionGranted\)/);
  assert.match(mainActivity, /\.put\("appNotificationsEnabled", appNotificationsEnabled\)/);
  assert.match(mainActivity, /\.put\("digestChannelEnabled", digestChannelEnabled\)/);
  assert.match(mainActivity, /\.put\("canPostDigest", canPostDigest\)/);
  assert.match(mainActivity, /authenticatedFallbackFacadeReadyScript/);
  assert.match(mainActivity, /window\.dispatchEvent\(new Event\('/);
  assert.match(mainActivity, /evogent:native-bridge-ready/);
  assert.match(settingsPanel, /getNotificationCapability/);
  assert.match(settingsPanel, /openNotificationListenerSettings/);
  assert.match(settingsPanel, /openNotificationSettings/);
  assert.match(settingsPanel, /schemaVersion:\s*1/);
  assert.match(settingsPanel, /postingPermissionGranted/);
  assert.match(settingsPanel, /canPostDigest/);
  assert.match(settingsPanel, /role="alert"/);
  assert.match(settingsPanel, /Every Android original will stay visible/);
  assert.match(settingsPanel, /Open Android notification access settings/);
  assert.match(settingsPanel, /Open Android notification settings/);
  assert.match(settingsPanel, /NATIVE_CAPABILITY_REFRESH_COALESCE_MS\s*=\s*50/);
  assert.match(settingsPanel, /if \(nativeCapabilityRefreshTimer\.current !== null\) return/);
  assert.match(
    settingsPanel,
    /nativeNotificationCapabilitiesEqual\(current, next\) \? current : next/,
  );
  assert.match(
    settingsPanel,
    /window\.addEventListener\('focus', scheduleNativeCapabilityRefresh\)/,
  );
  assert.match(
    settingsPanel,
    /window\.addEventListener\('evogent:native-bridge-ready', scheduleNativeCapabilityRefresh\)/,
  );
  assert.match(settingsPanel, /document\.addEventListener\('visibilitychange', refreshWhenVisible\)/);
  assert.match(
    architectureProse,
    /listener access.*Android notification-access-settings action/i,
  );
  assert.match(
    architectureProse,
    /coalesced into at most one native capability proof per short event burst/i,
  );
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

test('public runtime privacy contract distinguishes supported filtering from a hard boundary', () => {
  assert.match(architectureProse, /same Unix UID/i);
  assert.match(architectureProse, /not an OS confidentiality boundary/i);
  assert.match(
    architectureProse,
    /Android app-private, native-only storage that the provider UID cannot open/i,
  );
  assert.match(
    architectureProse,
    /genuine UID and mount\/filesystem isolation/i,
  );
  assert.match(
    architectureProse,
    /does not delete or claim deletion of provider-owned on-disk transcript files/i,
  );
  assert.match(
    architectureProse,
    /before loading it into memory so a later save cannot restore a removed entry/i,
  );
  assert.match(
    architectureProse,
    /malformed.*replaces it with an empty valid document and durably clears Evogent-owned task logs/i,
  );
  assert.match(auditCore, /mandatory worker policy/i);
  assert.match(auditCore, /Never use shell, filesystem, alternate endpoint, or direct SQLite access/i);
  assert.doesNotMatch(
    runtimePrivacyProse,
    /mechanically different identities|No runtime agent or external service receives the notification|every runtime-agent evidence bundle|Notification content never goes to the runtime brain|no notification content is sent to a runtime agent/i,
  );
});
