import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { NewSessionModal, lockDocumentScrollForModal } from './new-session-modal';

const noop = () => {};
const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
};
const modalProps = {
  claudeReasoningEffort: 'medium',
  claudeReasoningOptions: [{ value: 'medium', label: 'Medium' }],
  codexReasoningEffort: 'high',
  codexReasoningOptions: ['low', 'medium', 'high', 'xhigh'].map((value) => ({ value, label: value })),
  codexFastMode: false,
  colorOptions: Array.from({ length: 12 }, (_, index) => ({ value: `color-${index}`, swatch: '#0ea5e9' })),
  error: 'Validation failed',
  isOpen: true,
  isProviderLoading: false,
  isSubmitting: false,
  provider: 'codex',
  providerError: null,
  providerOptions: [{ value: 'codex', label: 'Codex' }],
  selectedColor: 'color-0',
  sessionType: 'normal' as const,
  title: 'New session',
  workingDirectory: '/root/evogent',
  onClose: noop,
  onAskAgent: noop,
  onSubmit: noop,
  onClaudeReasoningEffortChange: noop,
  onCodexReasoningEffortChange: noop,
  onCodexFastModeChange: noop,
  onColorChange: noop,
  onProviderChange: noop,
  onSessionTypeChange: noop,
  onTitleChange: noop,
  onWorkingDirectoryChange: noop,
};

afterEach(() => {
  Object.defineProperty(globalThis, 'document', { configurable: true, value: originalGlobals.document });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: originalGlobals.window });
});

describe('NewSessionModal mobile viewport layout', () => {
  test('bounds tall modal content and keeps actions in the scroll container', () => {
    const markup = renderToStaticMarkup(createElement(NewSessionModal, modalProps));
    const dialogTag = markup.match(/<form[^>]+data-testid="new-session-modal-dialog"[^>]*>/)?.[0] ?? '';
    const actionsIndex = markup.indexOf('data-testid="new-session-modal-actions"');

    assert.match(markup, /role="dialog"/);
    assert.match(markup, /class="[^"]*h-dvh[^"]*overflow-hidden[^"]*overscroll-contain/);
    for (const token of ['max-h-[calc(100vh-2rem)]', 'overflow-y-auto', 'overscroll-contain', 'scrollbar-gutter:stable']) {
      assert.ok(dialogTag.includes(token));
    }
    assert.match(dialogTag, /max-height:calc\(100dvh - max\(1rem, env\(safe-area-inset-top\)\) - max\(1rem, env\(safe-area-inset-bottom\)\)\)/);
    assert.ok(actionsIndex > markup.indexOf('Working directory'));
    assert.ok(actionsIndex > markup.indexOf('Validation failed'));
    assert.ok(markup.includes('Create session'));
  });

  test('locks background scroll and restores the previous page position', () => {
    const documentElement = { style: { overflow: 'visible' } };
    const body = { style: { overflow: 'auto', overscrollBehavior: '', position: '', top: '', width: '' } };
    let restoredScroll: [number, number] | null = null;

    Object.defineProperty(globalThis, 'document', { configurable: true, value: { body, documentElement } });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { scrollY: 900, scrollTo: (x: number, y: number) => { restoredScroll = [x, y]; } },
    });

    const unlock = lockDocumentScrollForModal();
    assert.deepStrictEqual(documentElement.style, { overflow: 'hidden' });
    assert.deepStrictEqual(body.style, {
      overflow: 'hidden',
      overscrollBehavior: 'contain',
      position: 'fixed',
      top: '-900px',
      width: '100%',
    });

    unlock();
    assert.deepStrictEqual(documentElement.style, { overflow: 'visible' });
    assert.deepStrictEqual(body.style, { overflow: 'auto', overscrollBehavior: '', position: '', top: '', width: '' });
    assert.deepStrictEqual(restoredScroll, [0, 900]);
  });
});
