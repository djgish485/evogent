import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const sessionPath = path.join(
  root,
  'android-shell/src/net/dangish/evogent/EvogentVoiceInteractionSession.java',
);
const session = fs.readFileSync(sessionPath, 'utf8');

function callableBody(source, signature) {
  const signatureIndex = source.indexOf(signature);
  assert.notEqual(signatureIndex, -1, `missing Java callable: ${signature}`);
  const openingBrace = source.indexOf('{', signatureIndex + signature.length);
  assert.notEqual(openingBrace, -1, `missing body for Java callable: ${signature}`);

  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openingBrace + 1, index);
    }
  }
  assert.fail(`unterminated body for Java callable: ${signature}`);
}

test('assistant privacy flags are applied only after the voice session is attached', () => {
  const constructor = callableBody(
    session,
    'EvogentVoiceInteractionSession(Context context)',
  );
  const onCreate = callableBody(session, 'public void onCreate()');

  assert.doesNotMatch(
    constructor,
    /setDisabledShowContext/,
    'VoiceInteractionSession has no system-service binder during construction',
  );

  const superCreate = onCreate.indexOf('super.onCreate();');
  const disableScreenshot = onCreate.indexOf(
    'setDisabledShowContext(SHOW_WITH_SCREENSHOT);',
  );
  assert.notEqual(superCreate, -1, 'session onCreate must call its superclass');
  assert.ok(
    disableScreenshot > superCreate,
    'screenshot capture must be disabled after superclass session initialization',
  );

  assert.equal(
    session.match(/setDisabledShowContext\s*\(/g)?.length,
    1,
    'the screenshot privacy policy must have one lifecycle-safe owner',
  );
});
