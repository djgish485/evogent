import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const mainActivity = fs.readFileSync(
  'android-shell/src/net/dangish/evogent/MainActivity.java',
  'utf8',
);
const loopbackAuth = fs.readFileSync(
  'android-shell/src/net/dangish/evogent/EvogentLoopbackAuth.java',
  'utf8',
);
const androidHomeResolution = fs.readFileSync(
  'android-shell/src/net/dangish/evogent/EvogentAndroidHomeResolution.java',
  'utf8',
);
const manifest = fs.readFileSync('android-shell/AndroidManifest.xml', 'utf8');
const strings = fs.readFileSync('android-shell/res/values/strings.xml', 'utf8');

function methodBody(name) {
  const declaration = new RegExp(
    `\\n {4}(?:private|protected|public)\\s+[^\\n;{]*\\b${name}\\(`,
  ).exec(mainActivity);
  assert.ok(declaration, `missing ${name}`);
  const start = declaration.index;
  const open = mainActivity.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < mainActivity.length; index += 1) {
    if (mainActivity[index] === '{') depth += 1;
    if (mainActivity[index] === '}') depth -= 1;
    if (depth === 0) return mainActivity.slice(open + 1, index);
  }
  assert.fail(`unterminated ${name}`);
}

test('explicit Evogent relaunch covers a cached WebView and requires a fresh proof', () => {
  const onNewIntent = methodBody('onNewIntent');
  const onResume = methodBody('onResume');
  const refreshExplicitLaunch = methodBody('refreshExplicitEvogentLaunch');

  assert.match(
    onNewIntent,
    /boolean explicitEvogent = isHomeSurface\(\) && isExplicitEvogentIntent\(intent\)/,
  );
  assert.match(
    onNewIntent,
    /if \(explicitEvogent\) \{[\s\S]*?pendingExplicitEvogentRefresh = true;[\s\S]*?refreshExplicitEvogentLaunch\(\);\s*return;/,
  );
  assert.match(
    onResume,
    /if \(pendingExplicitEvogentRefresh\)[\s\S]*?refreshExplicitEvogentLaunch\(\)/,
    'an explicit launch delivered before onResume can lose its required fresh proof',
  );
  assert.ok(
    onNewIntent.indexOf('refreshExplicitEvogentLaunch();')
      < onNewIntent.indexOf('dispatchPendingNotificationView();'),
    'explicit relaunch dispatched cached page work before its fresh process proof',
  );
  assert.match(refreshExplicitLaunch, /if \(!isCurrentFeedDocumentTrusted\(\)\) \{\s*loadFeedRoot\(\)/);
  assert.match(
    refreshExplicitLaunch,
    /showRecoveryStarting\(\);\s*refreshCurrentDocumentAuthentication\(/,
  );
  assert.match(refreshExplicitLaunch, /homeNavigation\.markAuthenticatedDocumentReady\(\)/);
  assert.match(refreshExplicitLaunch, /renderRecoverySurface\(\)/);
});

test('server-down recovery is native, escapable, and not an application overlay', () => {
  const createRecovery = methodBody('createRecoverySurface');
  const renderRecovery = methodBody('renderRecoverySurface');
  const shellPrompt = methodBody('handleShellPrompt');

  assert.match(createRecovery, /surface\.setBackgroundColor\(Color\.rgb\(5, 5, 5\)\)/);
  assert.match(createRecovery, /recoveryRetry\.setOnClickListener/);
  assert.match(createRecovery, /handleRecoveryEscape\(\)/);
  assert.match(renderRecovery, /webView\.setVisibility\(View\.INVISIBLE\)/);
  assert.match(renderRecovery, /recoverySurface\.setVisibility\(View\.VISIBLE\)/);
  assert.match(renderRecovery, /recoverySurface\.bringToFront\(\)/);
  assert.match(strings, /<string name="home_recovery_retry">Retry<\/string>/);
  assert.match(strings, /<string name="home_recovery_apps">Android Home<\/string>/);
  assert.doesNotMatch(manifest, /SYSTEM_ALERT_WINDOW|FOREGROUND_SERVICE_SPECIAL_USE/);
  assert.match(
    shellPrompt,
    /boundEscapeOperation[\s\S]*shellPrompt[\s\S]*"openAndroidHome"\.equals\(method\)/,
  );
  assert.match(
    shellPrompt,
    /boundDocumentOperation =\s*boundEscapeOperation \|\| boundCapabilityReadOperation[\s\S]*?authorizedOperation = boundDocumentOperation\s*\?\s*isCurrentFeedDocumentAuthenticated\(\)\s*:\s*authorizeCurrentDocumentForNativeAction\(\)/,
  );
});

test('system HOME owns the bounded no-preference-mutation fallback only', () => {
  const onNewIntent = methodBody('onNewIntent');
  const onPause = methodBody('onPause');
  const onResume = methodBody('onResume');
  const continueSystemHome = methodBody('continueSystemHomeInvocation');
  const unavailableFallback = methodBody('fallBackFromUnavailableSystemHome');

  assert.match(mainActivity, /SYSTEM_HOME_READY_TIMEOUT_MS = 2500L/);
  assert.match(onNewIntent, /if \(systemHome\) \{\s*armSystemHomeAvailabilityWait\(\)/);
  assert.match(
    onNewIntent,
    /if \(isHomeSurface\(\)\) \{[\s\S]*?cancelSystemHomeAvailabilityWait\(\)/,
  );
  assert.match(
    onNewIntent,
    /if \(!resumed\) \{\s*pendingSystemHomeResume = true;\s*return;/,
    'a HOME intent delivered before onResume is not retained',
  );
  assert.match(
    onResume,
    /resumePendingSystemHome[\s\S]*?armSystemHomeAvailabilityWait\(true\)[\s\S]*?continueSystemHomeInvocation\(pendingHomeRequest\)/,
    'paused HOME did not atomically replace its old token with a fresh foreground budget',
  );
  assert.match(
    continueSystemHome,
    /if \(markSystemHomeUsable\(availabilityRequest\)\) \{\s*homeNavigation\.markAuthenticatedDocumentReady\(\);\s*renderRecoverySurface\(\);\s*dispatchHomeGesture/,
  );
  assert.match(unavailableFallback, /requestRuntimeReviveIfDue\(\)/);
  assert.match(
    unavailableFallback,
    /systemHomeWatchdog\.execute\([\s\S]*?requestAndroidHomeFromWatchdog\([\s\S]*?deadlineElapsedMs[\s\S]*?true/,
    'definite failure did not defer generic HOME resolution and launch to the watchdog',
  );
  assert.doesNotMatch(
    unavailableFallback,
    /launchAndroidHomeWithoutChangingChoice\s*\(|startActivity\s*\(|resolveStockAndroidHome\s*\(/,
  );
  assert.match(
    onPause,
    /homeAvailability\.leaveForeground\(availabilityRequest\)[\s\S]*?cancelSystemHomeWatchdog\(\)[\s\S]*?\+\+authRequestId/,
    'pause did not arbitrate the old HOME watchdog and suspend all authentication retries',
  );
  assert.doesNotMatch(
    onPause,
    /homeAvailability\.isActive\(availabilityRequest\)/,
    'pause still depends on a gate that the watchdog may already have consumed',
  );
  assert.ok(
    onNewIntent.indexOf('cancelSystemHomeAvailabilityWait();')
      < onNewIntent.indexOf('routeHomeIntent(intent)'),
    'a newer user intent can route or persist before superseding the old watchdog',
  );
  assert.doesNotMatch(unavailableFallback, /rememberHomeChoice/);
});

test('cold system HOME draws native recovery and authenticates before WebView work', () => {
  const onCreate = methodBody('onCreate');
  const installNative = methodBody('installNativeRecoveryContent');
  const deferUntilDraw = methodBody(
    'deferColdWebViewAuthenticationUntilAfterFirstDraw',
  );
  const coldAuthentication = methodBody('beginColdWebViewAuthentication');
  const initializeWebView = methodBody('initializeAuthenticatedWebView');
  const renderRecovery = methodBody('renderRecoverySurface');
  const armWait = mainActivity.slice(
    mainActivity.indexOf(
      'private void armSystemHomeAvailabilityWait(boolean enterForegroundAtomically)',
    ),
    mainActivity.indexOf('private boolean markSystemHomeUsable'),
  );
  const watchdog = methodBody('requestAndroidHomeFromWatchdog');
  const arm = onCreate.indexOf('armSystemHomeAvailabilityWait();');

  assert.ok(arm >= 0, 'cold system HOME did not arm its availability deadline');
  assert.match(
    onCreate,
    /if \(systemHomeInvocation\) \{[\s\S]*?armSystemHomeAvailabilityWait\(\);[\s\S]*?pendingSystemHomeResume = true;/,
    'cold HOME can expire while backgrounded without being rearmed at first resume',
  );
  assert.ok(
    arm < onCreate.indexOf('routeHomeIntent(getIntent())'),
    'cold HOME routed before starting its availability budget',
  );
  assert.ok(
    onCreate.indexOf('installNativeRecoveryContent();')
      < onCreate.indexOf('captureNotificationViewIntent(getIntent());'),
    'cold HOME performed secondary intent work before installing native recovery',
  );
  assert.match(
    onCreate,
    /routeHomeIntent\(getIntent\(\)\)[\s\S]*?cancelSystemHomeAvailabilityWait\(\);[\s\S]*?finish\(\)/,
    'remembered stock HOME did not cancel the early Evogent availability timer',
  );
  assert.doesNotMatch(
    onCreate,
    /new WebView|clearCache|cancelLegacySchedule|retireLegacyOverlayArtifacts|loadFeedRoot/,
  );
  assert.match(
    installNative,
    /recoverySurface = createRecoverySurface\(\)[\s\S]*?setContentView\(activityRoot\)[\s\S]*?renderRecoverySurface\(\)/,
  );
  assert.match(deferUntilDraw, /addOnDrawListener/);
  assert.match(
    deferUntilDraw,
    /main\.post\([\s\S]*?beginColdWebViewAuthentication/,
  );
  assert.match(coldAuthentication, /EvogentLoopbackAuth\.authenticateWeb/);
  assert.ok(
    coldAuthentication.indexOf('EvogentLoopbackAuth.authenticateWeb')
      < coldAuthentication.indexOf('initializeAuthenticatedWebView('),
    'cold HOME constructed WebView before loopback authentication succeeded',
  );
  assert.doesNotMatch(coldAuthentication, /new WebView|clearCache/);
  assert.match(initializeWebView, /webView = new WebView\(this\)/);
  assert.match(initializeWebView, /webView\.clearCache\(true\)/);
  assert.match(
    initializeWebView,
    /activityRoot\.addView\(\s*webView,\s*0,/,
    'authenticated WebView was not inserted beneath native recovery',
  );
  assert.doesNotMatch(
    renderRecovery,
    /recoverySurface == null \|\| webView == null/,
    'native recovery could not render before WebView existed',
  );
  assert.match(
    armWait,
    /deadlineElapsedMs =\s*SystemClock\.elapsedRealtime\(\) \+ SYSTEM_HOME_READY_TIMEOUT_MS/,
  );
  assert.match(armWait, /systemHomeWatchdog\.schedule/);
  assert.ok(
    watchdog.indexOf('homeAvailability.launchFallbackIfCurrent(')
      < watchdog.indexOf('getApplicationContext().startActivity(fallback);'),
    'watchdog launch is not owned by the synchronized lifecycle/fallback arbiter',
  );
  assert.match(
    watchdog,
    /launchFallbackIfCurrent\([\s\S]*?new EvogentHomeAvailabilityGate\.FallbackAction\(\)[\s\S]*?startActivity\(fallback\)/,
  );
  assert.match(
    watchdog,
    /resolutionComplete[\s\S]*?launchWhenResolved[\s\S]*?SYSTEM_HOME_RESOLUTION_POLL_MS/,
    'an immediate auth failure can consume the gate before generic HOME resolution finishes',
  );
  assert.match(
    androidHomeResolution,
    /AtomicReference<Attempt<T>>[\s\S]*?compareAndSet\(/,
    'stock HOME request and target are not published as one atomic generation',
  );
  assert.match(
    watchdog,
    /target == null[\s\S]*?return false/,
    'an unresolved generic launcher can loop an implicit HOME intent back into Evogent',
  );
  assert.doesNotMatch(
    watchdog,
    /setPackage\(PIXEL_LAUNCHER_PACKAGE\)/,
    'bounded fallback still guesses a Pixel-only launcher package',
  );
  assert.ok(
    watchdog.indexOf('main.post(') < watchdog.indexOf('finish();'),
    'watchdog touched Activity lifecycle directly from its worker',
  );
  assert.match(
    watchdog,
    /if \(!launchRequested\)[\s\S]*?beginColdWebViewAuthentication\(AUTH_RETRY_MS, 0L\)[\s\S]*?authenticateAndLoad\(rootDocumentUrl\(\), AUTH_RETRY_MS, 0L\)/,
    'failed watchdog launch did not convert recovery to a revealable zero-token Evogent retry',
  );
  assert.match(
    coldAuthentication,
    /if \(destroyed[\s\S]*?\|\| !resumed[\s\S]*?\|\| !nativeRecoveryHasDrawn[\s\S]*?\|\| webView != null\) return;/,
    'cold recovery can run while backgrounded or before the first native frame',
  );
  assert.match(
    loopbackAuth,
    /CookieManager cookies = CookieManager\.getInstance\(\)[\s\S]*?catch \(Throwable providerFailure\)[\s\S]*?cookie_install_failed/,
    'cold CookieManager provider failure can crash instead of returning native recovery',
  );
});

test('main-frame callbacks carry exact load and HOME-request generations', () => {
  const onPageStarted = mainActivity.slice(
    mainActivity.indexOf('public void onPageStarted('),
    mainActivity.indexOf('public void onPageFinished('),
  );
  const onPageFinished = mainActivity.slice(
    mainActivity.indexOf('public void onPageFinished('),
    mainActivity.indexOf('public void onReceivedError('),
  );
  const onReceivedError = mainActivity.slice(
    mainActivity.indexOf('public void onReceivedError('),
    mainActivity.indexOf('public void onReceivedHttpError('),
  );
  const onReceivedHttpError = mainActivity.slice(
    mainActivity.indexOf('public void onReceivedHttpError('),
    mainActivity.indexOf('});', mainActivity.indexOf('public void onReceivedHttpError(')),
  );
  const failure = methodBody('handleAuthenticatedMainFrameFailure');
  const prepare = methodBody('prepareAuthenticatedMainFrameLoad');
  const restartReload = methodBody('restartRendererReload');
  const finishReady = methodBody('finishAuthenticatedDocumentReady');

  assert.match(onPageStarted, /EvogentMainFrameLoadPolicy\.acceptsPendingStart/);
  assert.match(
    onPageStarted,
    /EvogentMainFrameLoadPolicy\.isRendererReloadOfActiveDocument[\s\S]*?restartRendererReload\(url, callbackLoad\)/,
  );
  assert.ok(
    onPageStarted.indexOf('if (!exactPendingLoad)')
      < onPageStarted.indexOf('activeMainFrameLoad = authenticated'),
    'a non-pending start can still consume the current authorization',
  );
  assert.match(onPageFinished, /activeMainFrameLoad\.matches\(callbackLoad\)/);
  assert.match(
    onPageFinished,
    /readyMainFrameLoad != null[\s\S]*?readyMainFrameLoad\.matches\(callbackLoad\)/,
    'a duplicate finish callback can consume an already-won HOME token and cover healthy content',
  );
  for (const callback of [onReceivedError, onReceivedHttpError]) {
    assert.match(callback, /EvogentMainFrameLoadPolicy\.parse/);
    assert.match(callback, /ownsMainFrameCallback\(callbackLoad\)/);
    assert.match(callback, /callbackLoad\.homeAvailabilityRequest/);
  }
  assert.match(prepare, /EvogentMainFrameLoadPolicy\.bind/);
  assert.match(
    restartReload,
    /authenticateAndLoad\(targetUrl, 0L, homeAvailabilityRequest\)/,
  );
  assert.match(
    restartReload,
    /homeAvailability\.isActive\(currentHomeRequest\)[\s\S]*?: 0L/,
    'a later renderer reload reused the already-consumed HOME token embedded in its URL',
  );
  assert.doesNotMatch(
    restartReload,
    /callbackLoad\.homeAvailabilityRequest/,
  );
  assert.match(
    mainActivity,
    /homeNavigation\.beginAutomaticAttempt\(\);\s*revokeDocumentTrust\(\);\s*renderRecoverySurface\(\);\s*webView\.stopLoading\(\)/,
    'a renderer reload can remain visible/trusted while fresh authentication starts',
  );
  assert.ok(
    finishReady.indexOf('markSystemHomeUsable(')
      < finishReady.indexOf('homeNavigation.markAuthenticatedDocumentReady();'),
    'a document can become visible after losing its exact HOME availability request',
  );
  assert.ok(
    finishReady.indexOf('readyMainFrameLoad = callbackLoad;')
      < finishReady.indexOf('homeNavigation.markAuthenticatedDocumentReady();'),
    'successful readiness did not make duplicate finish callbacks inert',
  );
  assert.match(failure, /homeAvailabilityRequest/);
  assert.doesNotMatch(
    failure,
    /systemHomeAvailabilityRequest/,
    'a stale main-frame failure can still borrow the current HOME request',
  );
});
