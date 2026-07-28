import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOverlayScreenContextHandoff } from '@/lib/overlay-screen-context';

test('overlay mount captures once, remains previewable, then attaches only to the first send', () => {
  const handoff = createOverlayScreenContextHandoff();
  let bridgeReadCount = 0;

  const mountedPreview = handoff.captureOnce(() => {
    bridgeReadCount += 1;
    return JSON.stringify({
      app: 'com.example.reader',
      text: '  Visible words from the current screen  ',
    });
  });

  assert.deepStrictEqual(mountedPreview, { label: 'this screen' });
  assert.deepStrictEqual(handoff.preview(), mountedPreview);
  assert.deepStrictEqual(handoff.preview(), mountedPreview, 'preview must not consume the value');

  const firstSendContext = handoff.take();
  assert.deepStrictEqual(firstSendContext, {
    app: 'com.example.reader',
    text: 'Visible words from the current screen',
  });
  assert.strictEqual(handoff.preview(), null, 'the page must release context after the first send');
  assert.strictEqual(handoff.take(), null, 'a follow-up send must not reuse context');

  const recaptured = handoff.captureOnce(() => {
    bridgeReadCount += 1;
    return JSON.stringify({ app: 'com.example.other', text: 'different screen' });
  });
  assert.strictEqual(recaptured, null, 'a consumed one-shot value must never be recaptured');
  assert.strictEqual(bridgeReadCount, 1);
});

test('overlay mount with no usable context stays empty across first and repeat sends', () => {
  const cases: Array<string | null | undefined> = [
    undefined,
    null,
    '',
    '{not-json',
    JSON.stringify({ app: 'com.example.reader', text: '  ' }),
    JSON.stringify({ app: 'com.example.reader' }),
  ];

  for (const raw of cases) {
    const handoff = createOverlayScreenContextHandoff();
    let bridgeReadCount = 0;

    assert.strictEqual(handoff.captureOnce(() => {
      bridgeReadCount += 1;
      return raw;
    }), null);
    assert.strictEqual(handoff.preview(), null);
    assert.strictEqual(handoff.take(), null);
    assert.strictEqual(handoff.take(), null);
    assert.strictEqual(handoff.captureOnce(() => {
      bridgeReadCount += 1;
      return JSON.stringify({ app: null, text: 'late context' });
    }), null);
    assert.strictEqual(bridgeReadCount, 1);
  }
});

test('overlay bridge failures are contained and are not retried or surfaced', () => {
  const handoff = createOverlayScreenContextHandoff();
  let bridgeReadCount = 0;

  assert.strictEqual(handoff.captureOnce(() => {
    bridgeReadCount += 1;
    throw new Error('private bridge failure detail');
  }), null);
  assert.strictEqual(handoff.preview(), null);
  assert.strictEqual(handoff.take(), null);
  assert.strictEqual(handoff.captureOnce(() => {
    bridgeReadCount += 1;
    return JSON.stringify({ app: null, text: 'late context' });
  }), null);
  assert.strictEqual(bridgeReadCount, 1);
});

test('signal-first interleaving gives the signal sole ownership and leaves chat empty', () => {
  const handoff = createOverlayScreenContextHandoff();
  handoff.captureOnce(() => JSON.stringify({
    app: 'com.instagram.android',
    text: 'private post text',
  }));

  const signalContext = handoff.take();
  const chatContext = handoff.take();

  assert.deepStrictEqual(signalContext, {
    app: 'com.instagram.android',
    text: 'private post text',
  });
  assert.strictEqual(chatContext, null);
  assert.strictEqual(handoff.preview(), null);
});

test('chat-first interleaving gives chat sole ownership and leaves the signal empty', () => {
  const handoff = createOverlayScreenContextHandoff();
  handoff.captureOnce(() => JSON.stringify({
    app: 'com.twitter.android',
    text: 'private tweet text',
  }));

  const chatContext = handoff.take();
  const signalContext = handoff.take();

  assert.deepStrictEqual(chatContext, {
    app: 'com.twitter.android',
    text: 'private tweet text',
  });
  assert.strictEqual(signalContext, null);
  assert.strictEqual(handoff.preview(), null);
});

test('same-tick signal double-click can acquire the context only once', () => {
  const handoff = createOverlayScreenContextHandoff();
  handoff.captureOnce(() => JSON.stringify({
    app: 'com.example.reader',
    text: 'private screen text',
  }));

  const firstClickContext = handoff.take();
  const secondClickContext = handoff.take();

  assert.deepStrictEqual(firstClickContext, {
    app: 'com.example.reader',
    text: 'private screen text',
  });
  assert.strictEqual(secondClickContext, null);
  assert.strictEqual(handoff.preview(), null);
});

test('preview exposes only a display label, never the app identifier or screen text', () => {
  const handoff = createOverlayScreenContextHandoff();
  const preview = handoff.captureOnce(() => JSON.stringify({
    app: 'com.instagram.android',
    text: 'private post text',
  }));

  assert.deepStrictEqual(preview, { label: 'this Instagram post' });
  assert.doesNotMatch(JSON.stringify(preview), /com\.instagram|private post/i);
});
