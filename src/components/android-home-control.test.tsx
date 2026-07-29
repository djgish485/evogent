import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

import { AndroidHomeControl } from './android-home-control';

type TestGlobal = typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

(globalThis as TestGlobal).IS_REACT_ACT_ENVIRONMENT = true;

test('Android Home appears when the authenticated native facade becomes ready after mount', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'https://127.0.0.1:3443/',
  });
  const previous = {
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    MouseEvent: globalThis.MouseEvent,
    navigator: globalThis.navigator,
    window: globalThis.window,
  };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: dom.window,
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: dom.window.document,
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: dom.window.navigator,
  });
  Object.defineProperty(globalThis, 'HTMLElement', {
    configurable: true,
    value: dom.window.HTMLElement,
  });
  Object.defineProperty(globalThis, 'MouseEvent', {
    configurable: true,
    value: dom.window.MouseEvent,
  });

  const container = dom.window.document.getElementById('root');
  assert.ok(container);
  const root = createRoot(container);
  let openCount = 0;

  try {
    await act(async () => {
      root.render(createElement(AndroidHomeControl));
    });
    assert.equal(
      container.querySelector('[data-testid="android-home-button"]'),
      null,
    );

    Object.defineProperty(dom.window, 'EvogentShell', {
      configurable: true,
      value: {
        openAndroidHome: () => {
          openCount += 1;
        },
      },
    });
    await act(async () => {
      dom.window.dispatchEvent(
        new dom.window.Event('evogent:native-bridge-ready'),
      );
    });

    const androidHome = container.querySelector<HTMLButtonElement>(
      '[data-testid="android-home-button"]',
    );
    assert.ok(androidHome);
    assert.equal(androidHome.getAttribute('aria-label'), 'Android home screen');

    await act(async () => {
      androidHome.dispatchEvent(
        new dom.window.MouseEvent('click', { bubbles: true }),
      );
    });
    assert.equal(openCount, 1);
  } finally {
    await act(async () => {
      root.unmount();
    });
    dom.window.close();
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: previous.document,
    });
    Object.defineProperty(globalThis, 'HTMLElement', {
      configurable: true,
      value: previous.HTMLElement,
    });
    Object.defineProperty(globalThis, 'MouseEvent', {
      configurable: true,
      value: previous.MouseEvent,
    });
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: previous.navigator,
    });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: previous.window,
    });
  }
});
