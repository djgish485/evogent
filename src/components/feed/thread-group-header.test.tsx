import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import { AppRouterContext, type AppRouterInstance } from 'next/dist/shared/lib/app-router-context.shared-runtime';

import type { FeedItem } from '@/types/feed';
import { ThreadGroup } from './thread-group';
import { ThreadGroupHeader } from './thread-group-header';

const threadTint = {
  name: 'blue',
  bg: 'rgba(59,130,246,0.08)',
  border: 'rgba(59,130,246,0.45)',
  itemBorder: 'rgba(59,130,246,0.22)',
  swatch: 'rgb(59 130 246)',
  text: '#93c5fd',
};

type HeaderProps = Parameters<typeof ThreadGroupHeader>[0];

const defaultHeaderProps: HeaderProps = {
  threadId: 'thread-1',
  threadTitle: 'Ordinary thread',
  threadSubtitle: null,
  threadProminence: null,
  continuing: false,
  threadTint,
  isCollapsed: false,
  contentsId: 'thread-contents',
  onToggleCollapsed: () => {},
  onThumbsDownThread: () => {},
  onSubmitFeedback: async () => {},
};

function renderHeaderMarkup(overrides: Partial<HeaderProps> = {}): string {
  return renderToStaticMarkup(createElement(ThreadGroupHeader, {
    ...defaultHeaderProps,
    ...overrides,
  }));
}

type TestGlobal = typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

const reactActGlobal = globalThis as TestGlobal;
reactActGlobal.IS_REACT_ACT_ENVIRONMENT = true;

function createFeedItem(id: string, title: string, type: FeedItem['type'] = 'article'): FeedItem {
  return {
    id,
    type,
    source: type === 'analysis' ? 'evogent' : 'web',
    sourceId: id,
    parentId: null,
    relationship: type === 'analysis' ? 'analysis' : 'related',
    title,
    text: `${title} body text`,
    url: null,
    excerpt: `${title} excerpt`,
    authorUsername: null,
    authorDisplayName: null,
    reason: null,
    tags: [],
    mediaUrls: [],
    metrics: { likes: 0, reposts: 0, replies: 0 },
    authorAvatarUrl: null,
    isLiked: false,
    isDisliked: false,
    parentItem: null,
    children: [],
    childrenCount: 0,
    suggestionChildren: [],
    analysisPresentation: null,
    metadata: {
      thread: {
        threadId: 'thread-1',
        threadTitle: 'Collapsible thread',
        color: 'blue',
      },
    },
    publishedAt: '2026-04-01T00:00:00.000Z',
    createdAt: '2026-04-01T00:00:00.000Z',
  };
}

function createTestRouter(): AppRouterInstance {
  return {
    back: () => {},
    forward: () => {},
    refresh: () => {},
    push: () => {},
    replace: () => {},
    prefetch: () => {},
  };
}

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
  });
  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    navigator: globalThis.navigator,
    HTMLElement: globalThis.HTMLElement,
    SVGElement: globalThis.SVGElement,
    Node: globalThis.Node,
    Event: globalThis.Event,
    MouseEvent: globalThis.MouseEvent,
    KeyboardEvent: globalThis.KeyboardEvent,
    fetch: globalThis.fetch,
  };

  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
  Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: dom.window.HTMLElement });
  Object.defineProperty(globalThis, 'SVGElement', { configurable: true, value: dom.window.SVGElement });
  Object.defineProperty(globalThis, 'Node', { configurable: true, value: dom.window.Node });
  Object.defineProperty(globalThis, 'Event', { configurable: true, value: dom.window.Event });
  Object.defineProperty(globalThis, 'MouseEvent', { configurable: true, value: dom.window.MouseEvent });
  Object.defineProperty(globalThis, 'KeyboardEvent', { configurable: true, value: dom.window.KeyboardEvent });

  return () => {
    Object.defineProperty(globalThis, 'document', { configurable: true, value: previous.document });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previous.window });
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: previous.navigator });
    Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: previous.HTMLElement });
    Object.defineProperty(globalThis, 'SVGElement', { configurable: true, value: previous.SVGElement });
    Object.defineProperty(globalThis, 'Node', { configurable: true, value: previous.Node });
    Object.defineProperty(globalThis, 'Event', { configurable: true, value: previous.Event });
    Object.defineProperty(globalThis, 'MouseEvent', { configurable: true, value: previous.MouseEvent });
    Object.defineProperty(globalThis, 'KeyboardEvent', { configurable: true, value: previous.KeyboardEvent });
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: previous.fetch });
  };
}

async function renderThreadGroupForInteraction() {
  const restoreDom = installDom();
  const container = document.getElementById('root');
  assert.ok(container);

  const feedbackSubmissions: Array<{ vote: 'up' | 'down' }> = [];
  const interactionRequests: Array<{ feedItemId: string; action: string; reason?: string }> = [];
  const root = createRoot(container);
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof init?.body === 'string') {
        interactionRequests.push(JSON.parse(init.body) as { feedItemId: string; action: string; reason?: string });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  await act(async () => {
    root.render(
      <AppRouterContext.Provider value={createTestRouter()}>
        <ThreadGroup
          threadId="thread-1"
          threadTitle="Collapsible thread"
          threadSubtitle="A short reason for this thread."
          threadProminence={{ level: 'prominent' }}
          continuing={false}
          analysisItems={[createFeedItem('analysis-1', 'Analysis item one', 'analysis')]}
          items={[
            createFeedItem('item-1', 'Regular item one'),
            createFeedItem('item-2', 'Regular item two'),
          ]}
          agentName="Evo"
          onChat={() => {}}
          onOpenDetail={() => {}}
          onSubmitFeedback={async (input) => {
            feedbackSubmissions.push({ vote: input.vote });
          }}
        />
      </AppRouterContext.Provider>,
    );
  });

  return {
    container,
    feedbackSubmissions,
    interactionRequests,
    async cleanup() {
      await act(async () => {
        root.unmount();
      });
      restoreDom();
    },
  };
}

function clickElement(element: Element) {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

function keyDownElement(element: Element, key: string) {
  element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

function getHeader(container: Element): HTMLElement {
  const header = container.querySelector<HTMLElement>('header[role="button"]');
  assert.ok(header);
  return header;
}

function getButton(container: Element, selector: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(selector);
  assert.ok(button);
  return button;
}

function getButtonByText(container: Element, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
    .find((candidate) => candidate.textContent?.trim() === text);
  assert.ok(button);
  return button;
}

describe('ThreadGroupHeader', () => {
  test('renders lead thread prominence with stronger title typography', () => {
    const markup = renderHeaderMarkup({
      threadTitle: 'Major homepage event',
      threadProminence: {
        level: 'lead',
        source: 'homepage',
        evidence: 'Largest headline on the homepage.',
      },
    });

    assert.match(markup, /data-prominence="lead"/);
    assert.match(markup, /text-\[22px\] font-semibold leading-tight text-zinc-50 sm:text-\[28px\]/);
    assert.match(markup, /linear-gradient\(to bottom, rgba\(59,130,246,0.08\), transparent\) padding-box/);
    assert.match(markup, /linear-gradient\(to bottom, rgba\(59,130,246,0.45\), transparent\) border-box/);
  });

  test('keeps ordinary thread titles at the normal size', () => {
    const markup = renderHeaderMarkup({
      threadTitle: 'Ordinary thread',
    });

    assert.doesNotMatch(markup, /data-prominence=/);
    assert.match(markup, /text-lg font-semibold text-zinc-100 sm:text-xl/);
    assert.doesNotMatch(markup, /Optional reason/);
    assert.doesNotMatch(markup, /More like this/);
    assert.doesNotMatch(markup, /Tune this lane/);
  });

  test('lets thread title and subtitle sit below the feedback row at full width', () => {
    const markup = renderHeaderMarkup({
      threadTitle: 'Long ordinary thread title',
      threadSubtitle: 'This subtitle should use the natural card width instead of a capped text column.',
      continuing: true,
    });

    assert.match(markup, /role="button"/);
    assert.match(markup, /tabindex="0"/);
    assert.match(markup, /aria-expanded="true"/);
    assert.match(markup, /aria-controls="thread-contents"/);
    assert.match(markup, /class="cursor-pointer rounded-t-2xl border border-transparent p-4 outline-none/);
    assert.match(markup, /class="flex flex-row items-start justify-between gap-3 sm:gap-4"/);
    assert.match(markup, /Continuing from earlier/);
    assert.match(markup, /<div class="mt-2 space-y-1"><h2/);
    assert.match(markup, /<p class="text-sm leading-6 text-zinc-300">/);
    assert.doesNotMatch(markup, /max-w-2xl/);
  });

  test('renders large A/B controls for feedback probe threads', () => {
    const markup = renderHeaderMarkup({
      threadTitle: 'Borderline but good thread',
      feedbackProbe: {
        reason: 'High quality but uncertain lane fit.',
        uncertainty: 'source fatigue',
        options: {
          moreLabel: 'Keep pushing',
          lessLabel: 'Stop pushing',
        },
      },
      sourceItemIds: ['item-1', 'item-2'],
    });

    assert.match(markup, /Tune this lane/);
    assert.match(markup, /Keep pushing/);
    assert.match(markup, /Stop pushing/);
    assert.match(markup, /min-h-12/);
    assert.doesNotMatch(markup, /Optional reason/);
  });

  test('clicking the thread header toggles collapsed content with the hidden count', async () => {
    const rendered = await renderThreadGroupForInteraction();

    try {
      const header = getHeader(rendered.container);
      assert.equal(header.getAttribute('aria-expanded'), 'true');
      assert.match(rendered.container.textContent ?? '', /Analysis item one/);
      assert.match(rendered.container.textContent ?? '', /Regular item one/);

      await act(async () => {
        clickElement(header);
      });

      assert.equal(header.getAttribute('aria-expanded'), 'false');
      assert.match(rendered.container.textContent ?? '', /3 items hidden - tap to expand/);
      assert.doesNotMatch(rendered.container.textContent ?? '', /Analysis item one/);
      assert.doesNotMatch(rendered.container.textContent ?? '', /Regular item one/);

      await act(async () => {
        clickElement(header);
      });

      assert.equal(header.getAttribute('aria-expanded'), 'true');
      assert.doesNotMatch(rendered.container.textContent ?? '', /items hidden/);
      assert.match(rendered.container.textContent ?? '', /Regular item two/);
    } finally {
      await rendered.cleanup();
    }
  });

  test('feedback buttons submit without toggling the current collapsed state', async () => {
    const rendered = await renderThreadGroupForInteraction();

    try {
      const header = getHeader(rendered.container);
      const thumbsUp = getButton(rendered.container, 'button[aria-label="Thumbs up thread"]');

      await act(async () => {
        clickElement(thumbsUp);
      });
      await act(async () => {
        clickElement(getButtonByText(rendered.container, 'Save'));
      });

      assert.equal(header.getAttribute('aria-expanded'), 'true');
      assert.doesNotMatch(rendered.container.textContent ?? '', /items hidden/);
      assert.deepEqual(rendered.feedbackSubmissions, [{ vote: 'up' }]);

      await act(async () => {
        clickElement(header);
      });
      assert.equal(header.getAttribute('aria-expanded'), 'false');

      const thumbsDown = getButton(rendered.container, 'button[aria-label="Thumbs down thread"]');
      await act(async () => {
        clickElement(thumbsDown);
      });

      assert.match(rendered.container.textContent ?? '', /Undo/);
      assert.match(rendered.container.textContent ?? '', /Optional reason/);
      assert.doesNotMatch(rendered.container.textContent ?? '', /3 items hidden - tap to expand/);
      assert.doesNotMatch(rendered.container.textContent ?? '', /Regular item one/);
      assert.deepEqual(rendered.feedbackSubmissions, [{ vote: 'up' }]);
      assert.deepEqual(
        rendered.interactionRequests.filter((request) => request.action === 'thumbsdown').map((request) => request.feedItemId).sort(),
        ['analysis-1', 'item-1', 'item-2'],
      );
    } finally {
      await rendered.cleanup();
    }
  });

  test('Enter and Space on the focused header toggle the collapsed state', async () => {
    const rendered = await renderThreadGroupForInteraction();

    try {
      const header = getHeader(rendered.container);
      header.focus();
      assert.equal(document.activeElement, header);

      await act(async () => {
        keyDownElement(header, 'Enter');
      });

      assert.equal(header.getAttribute('aria-expanded'), 'false');
      assert.match(rendered.container.textContent ?? '', /3 items hidden - tap to expand/);

      await act(async () => {
        keyDownElement(header, ' ');
      });

      assert.equal(header.getAttribute('aria-expanded'), 'true');
      assert.doesNotMatch(rendered.container.textContent ?? '', /items hidden/);
      assert.match(rendered.container.textContent ?? '', /Regular item one/);
    } finally {
      await rendered.cleanup();
    }
  });
});
