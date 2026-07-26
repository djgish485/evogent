import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';

import { FeedNoticeStack } from './feed-notice-stack';

type TestGlobal = typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

(globalThis as TestGlobal).IS_REACT_ACT_ENVIRONMENT = true;

describe('FeedNoticeStack', () => {
  test('keeps simultaneous phone notices in one responsive vertical lane', () => {
    const markup = renderToStaticMarkup(createElement(FeedNoticeStack, {
      headerOffsetPx: 72,
      pendingItemCount: 10,
      reorganizedItemCount: 9,
      searchQuery: 'device testing',
      onRevealPendingItems: () => {},
      onShowArrangedFeedOrder: () => {},
      onClearSearch: () => {},
    }));

    assert.match(markup, /data-testid="feed-notice-stack"/);
    assert.match(markup, /sticky/);
    assert.match(markup, /flex-col/);
    assert.match(markup, /gap-2/);
    assert.match(markup, /min-w-0/);
    assert.doesNotMatch(markup, /\bfixed\b/);
    assert.match(markup, /10 new posts/);
    assert.match(markup, /9 items reorganized/);
    assert.match(markup, /Show new order/);
    assert.match(markup, /Results for “device testing”/);
    assert.match(markup, /Clear active search/);
  });

  test('keeps the two simultaneous actions independently tappable', async () => {
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: 'http://localhost/',
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

    let revealCount = 0;
    let reorderCount = 0;
    let clearSearchCount = 0;
    const container = dom.window.document.getElementById('root');
    assert.ok(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(createElement(FeedNoticeStack, {
          headerOffsetPx: 72,
          pendingItemCount: 2,
          reorganizedItemCount: 3,
          searchQuery: 'combined state',
          onRevealPendingItems: () => { revealCount += 1; },
          onShowArrangedFeedOrder: () => { reorderCount += 1; },
          onClearSearch: () => { clearSearchCount += 1; },
        }));
      });

      const newPostsButton = container.querySelector<HTMLButtonElement>('[data-testid="new-posts-button"]');
      const reorderButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent?.includes('Show new order'));
      const clearSearchButton = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Clear active search"]',
      );
      assert.ok(newPostsButton);
      assert.ok(reorderButton);
      assert.ok(clearSearchButton);
      assert.notEqual(newPostsButton, reorderButton);
      assert.notEqual(newPostsButton, clearSearchButton);
      assert.notEqual(reorderButton, clearSearchButton);

      await act(async () => {
        newPostsButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
        reorderButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
        clearSearchButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      });

      assert.equal(revealCount, 1);
      assert.equal(reorderCount, 1);
      assert.equal(clearSearchCount, 1);
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
});
