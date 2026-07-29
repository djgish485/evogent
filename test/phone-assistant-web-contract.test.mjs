import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const page = fs.readFileSync('src/app/page.tsx', 'utf8');
const actions = fs.readFileSync(
  'src/components/assistant-surface-actions.tsx',
  'utf8',
);
const contextHandoff = fs.readFileSync(
  'src/lib/overlay-screen-context.ts',
  'utf8',
);
const mainActivity = fs.readFileSync(
  'android-shell/src/net/dangish/evogent/MainActivity.java',
  'utf8',
);

test('assistant surface always exposes named phone-sized escape actions', () => {
  assert.match(page, /<AssistantSurfaceActions/);
  assert.match(page, /onClose=\{\(\) => invokeAssistantBridgeAction\('close'\)\}/);
  assert.match(page, /onOpenEvogent=\{\(\) => invokeAssistantBridgeAction\('openApp'\)\}/);
  assert.match(actions, />\s*Open Evogent\s*</);
  assert.match(actions, /aria-label="Close Add Message"/);
  assert.match(actions, /min-h-12/);
  assert.match(actions, /h-12 w-12/);
});

test('assistant context is actively bounded and cannot return after abandonment', () => {
  assert.match(contextHandoff, /ASSISTANT_SCREEN_CONTEXT_TTL_MS = 5 \* 60 \* 1000/);
  assert.match(contextHandoff, /const clear = \(\) => \{[\s\S]*?didCapture = true/);
  assert.match(page, /window\.setTimeout\(\s*abandonScreenContext,\s*ASSISTANT_SCREEN_CONTEXT_TTL_MS/);
  assert.match(page, /window\.addEventListener\('pagehide', abandonScreenContext\)/);
  assert.match(page, /document\.addEventListener\('visibilitychange', handleVisibilityChange\)/);
  assert.match(
    page,
    /if \(document\.visibilityState === 'hidden'\) \{\s*clearOverlayScreenContext\(\)/,
  );
  assert.match(page, /clearOverlayScreenContext\(\);[\s\S]*?bridge\?\.\[action\]\?\.\(\)/);
});

test('authenticated late facade readiness closes the document-start race without polling', () => {
  assert.match(
    contextHandoff,
    /EVOGENT_NATIVE_BRIDGE_READY_EVENT = 'evogent:native-bridge-ready'/,
  );
  assert.match(
    page,
    /window\.addEventListener\(EVOGENT_NATIVE_BRIDGE_READY_EVENT, captureFromReadyBridge\)/,
  );
  assert.match(
    page,
    /typeof bridge\?\.close === 'function'[\s\S]*?typeof bridge\.getScreenContext === 'function'[\s\S]*?typeof bridge\.openApp === 'function'/,
  );
  assert.doesNotMatch(page, /setInterval\([^)]*captureFromReadyBridge/);
});

test('system-managed assistant Activity does not make redundant native sizing calls', () => {
  assert.doesNotMatch(page, /\.setHeight\(/);
  assert.doesNotMatch(page, /EvogentOverlay\?: \{ setHeight/);
});

test('assistant escape remains available without weakening sensitive native operations', () => {
  assert.match(
    mainActivity,
    /boolean assistantEscapeOperation = assistantPrompt[\s\S]*?"close"\.equals\(method\)[\s\S]*?"openApp"\.equals\(method\)/,
  );
  assert.match(
    mainActivity,
    /boolean boundEscapeOperation =\s*assistantEscapeOperation \|\| shellHomeEscapeOperation/,
  );
  assert.match(
    mainActivity,
    /boolean boundDocumentOperation =\s*boundEscapeOperation \|\| boundCapabilityReadOperation[\s\S]*?boolean authorizedOperation = boundDocumentOperation\s*\? isCurrentFeedDocumentAuthenticated\(\)\s*: authorizeCurrentDocumentForNativeAction\(\)/,
  );
});
