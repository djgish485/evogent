import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';

import { AssistantSurfaceActions } from './assistant-surface-actions';

type TestGlobal = typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

(globalThis as TestGlobal).IS_REACT_ACT_ENVIRONMENT = true;

test('assistant controls are named, visible, and use phone-sized targets', () => {
  const markup = renderToStaticMarkup(createElement(AssistantSurfaceActions, {
    bridgeReady: true,
    onClose: () => {},
    onOpenEvogent: () => {},
  }));

  assert.match(markup, /data-testid="assistant-surface-actions"/);
  assert.match(markup, />Add Message</);
  assert.match(markup, />Open Evogent</);
  assert.match(markup, /aria-label="Close Add Message"/);
  assert.match(markup, /min-h-12/);
  assert.match(markup, /h-12 w-12/);
});

test('assistant controls stay inert until the authenticated native bridge is ready', () => {
  const markup = renderToStaticMarkup(createElement(AssistantSurfaceActions, {
    bridgeReady: false,
    onClose: () => {},
    onOpenEvogent: () => {},
  }));

  assert.equal((markup.match(/disabled=""/g) ?? []).length, 2);
});

test('assistant controls invoke only their selected native action', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'https://127.0.0.1:3443/?overlay=1',
  });
  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    navigator: globalThis.navigator,
    HTMLElement: globalThis.HTMLElement,
    MouseEvent: globalThis.MouseEvent,
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
  Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: dom.window.HTMLElement });
  Object.defineProperty(globalThis, 'MouseEvent', { configurable: true, value: dom.window.MouseEvent });

  let closeCount = 0;
  let openCount = 0;
  const container = dom.window.document.getElementById('root');
  assert.ok(container);
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(createElement(AssistantSurfaceActions, {
        bridgeReady: true,
        onClose: () => { closeCount += 1; },
        onOpenEvogent: () => { openCount += 1; },
      }));
    });

    const close = container.querySelector<HTMLButtonElement>('[data-testid="assistant-close"]');
    const open = container.querySelector<HTMLButtonElement>('[data-testid="assistant-open-evogent"]');
    assert.ok(close);
    assert.ok(open);

    await act(async () => {
      open.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    assert.equal(openCount, 1);
    assert.equal(closeCount, 0);

    await act(async () => {
      close.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    assert.equal(openCount, 1);
    assert.equal(closeCount, 1);
  } finally {
    await act(async () => {
      root.unmount();
    });
    dom.window.close();
    Object.defineProperty(globalThis, 'document', { configurable: true, value: previous.document });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previous.window });
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: previous.navigator });
    Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: previous.HTMLElement });
    Object.defineProperty(globalThis, 'MouseEvent', { configurable: true, value: previous.MouseEvent });
  }
});
