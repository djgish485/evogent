import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const mainActivity = fs.readFileSync(
  'android-shell/src/net/dangish/evogent/MainActivity.java',
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
  const refreshExplicitLaunch = methodBody('refreshExplicitEvogentLaunch');

  assert.match(
    onNewIntent,
    /boolean explicitEvogent = isHomeSurface\(\) && isExplicitEvogentIntent\(intent\)/,
  );
  assert.match(
    onNewIntent,
    /if \(explicitEvogent\) \{\s*refreshExplicitEvogentLaunch\(\);\s*return;/,
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

  assert.match(createRecovery, /surface\.setBackgroundColor\(Color\.rgb\(5, 5, 5\)\)/);
  assert.match(createRecovery, /recoveryRetry\.setOnClickListener/);
  assert.match(createRecovery, /handleRecoveryEscape\(\)/);
  assert.match(renderRecovery, /webView\.setVisibility\(View\.INVISIBLE\)/);
  assert.match(renderRecovery, /recoverySurface\.setVisibility\(View\.VISIBLE\)/);
  assert.match(renderRecovery, /recoverySurface\.bringToFront\(\)/);
  assert.match(strings, /<string name="home_recovery_retry">Retry<\/string>/);
  assert.match(strings, /<string name="home_recovery_apps">Android Home<\/string>/);
  assert.doesNotMatch(manifest, /SYSTEM_ALERT_WINDOW|FOREGROUND_SERVICE_SPECIAL_USE/);
});

test('system HOME owns the bounded no-preference-mutation fallback only', () => {
  const onNewIntent = methodBody('onNewIntent');
  const unavailableFallback = methodBody('fallBackFromUnavailableSystemHome');
  const automaticAndroidHome = methodBody('launchAndroidHomeWithoutChangingChoice');

  assert.match(mainActivity, /SYSTEM_HOME_READY_TIMEOUT_MS = 2500L/);
  assert.match(onNewIntent, /if \(systemHome\) \{\s*armSystemHomeAvailabilityWait\(\)/);
  assert.match(onNewIntent, /else \{[\s\S]*?cancelSystemHomeAvailabilityWait\(\)/);
  assert.match(
    onNewIntent,
    /if \(markSystemHomeUsable\(availabilityRequest\)\) \{\s*homeNavigation\.markAuthenticatedDocumentReady\(\);\s*renderRecoverySurface\(\);\s*dispatchHomeGesture/,
  );
  assert.match(unavailableFallback, /requestRuntimeReviveIfDue\(\)/);
  assert.match(unavailableFallback, /launchAndroidHomeWithoutChangingChoice\(\)/);
  assert.match(
    automaticAndroidHome,
    /EvogentHomeChoicePolicy\.launchAndroidHomeWithoutChangingChoice/,
  );
  assert.doesNotMatch(automaticAndroidHome, /rememberHomeChoice/);
});
