import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ASSISTANT_SCREEN_CONTEXT_TTL_MS,
  captureOverlayScreenContextFromBridge,
  createOverlayScreenContextHandoff,
} from '@/lib/overlay-screen-context';

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

test('missing bridge does not burn the one-shot before authenticated fallback readiness', () => {
  const handoff = createOverlayScreenContextHandoff();
  let reads = 0;

  assert.strictEqual(
    captureOverlayScreenContextFromBridge(handoff, undefined),
    undefined,
  );
  assert.strictEqual(
    captureOverlayScreenContextFromBridge(handoff, {}),
    undefined,
  );

  const preview = captureOverlayScreenContextFromBridge(handoff, {
    getScreenContext() {
      reads += 1;
      return JSON.stringify({
        app: 'com.example.reader',
        text: 'context supplied after authenticated fallback injection',
      });
    },
  });

  assert.deepStrictEqual(preview, { label: 'this screen' });
  assert.equal(reads, 1);
  assert.match(handoff.take()?.text ?? '', /authenticated fallback injection/);
});

test('explicit abandonment clears raw context and prevents every late reacquisition', () => {
  const handoff = createOverlayScreenContextHandoff();
  let reads = 0;
  handoff.captureOnce(() => {
    reads += 1;
    return JSON.stringify({
      app: 'com.example.reader',
      text: 'abandoned private context',
    });
  });

  handoff.clear();

  assert.strictEqual(handoff.preview(), null);
  assert.strictEqual(handoff.take(), null);
  assert.strictEqual(handoff.captureOnce(() => {
    reads += 1;
    return JSON.stringify({ app: 'com.example.other', text: 'late private context' });
  }), null);
  assert.equal(reads, 1);
});

test('abandonment before fallback readiness prevents a late bridge from reading context', () => {
  const handoff = createOverlayScreenContextHandoff();
  let reads = 0;

  assert.strictEqual(
    captureOverlayScreenContextFromBridge(handoff, undefined),
    undefined,
  );
  handoff.clear();

  assert.strictEqual(
    captureOverlayScreenContextFromBridge(handoff, {
      getScreenContext() {
        reads += 1;
        return JSON.stringify({
          app: 'com.example.reader',
          text: 'late bridge must never read this value',
        });
      },
    }),
    null,
  );
  assert.equal(reads, 0);
  assert.strictEqual(handoff.preview(), null);
  assert.strictEqual(handoff.take(), null);
});

test('raw context expires even when a throttled page timer has not run', () => {
  let nowMs = 10_000;
  const handoff = createOverlayScreenContextHandoff({
    now: () => nowMs,
    ttlMs: ASSISTANT_SCREEN_CONTEXT_TTL_MS,
  });
  handoff.captureOnce(() => JSON.stringify({
    app: 'com.example.reader',
    text: 'time bounded private context',
  }));

  nowMs += ASSISTANT_SCREEN_CONTEXT_TTL_MS - 1;
  assert.deepStrictEqual(handoff.preview(), { label: 'this screen' });

  nowMs += 1;
  assert.strictEqual(handoff.preview(), null);
  assert.strictEqual(handoff.take(), null);
  assert.strictEqual(handoff.captureOnce(() => JSON.stringify({
    app: 'com.example.other',
    text: 'must not be reacquired',
  })), null);
});
