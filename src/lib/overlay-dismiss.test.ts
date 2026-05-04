import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import {
  __getTopOverlayIdForTests,
  __registerOverlayForTests,
  __resetOverlayDismissStackForTests,
  __unregisterOverlayForTests,
  resolveOverlayDismissOptions,
} from './overlay-dismiss';

afterEach(() => {
  __resetOverlayDismissStackForTests();
});

describe('overlay dismiss stack', () => {
  test('tracks the most recently registered overlay as topmost', () => {
    __registerOverlayForTests('outer');
    __registerOverlayForTests('inner');

    assert.equal(__getTopOverlayIdForTests(), 'inner');
  });

  test('promotes an overlay when it registers again', () => {
    __registerOverlayForTests('outer');
    __registerOverlayForTests('inner');
    __registerOverlayForTests('outer');

    assert.equal(__getTopOverlayIdForTests(), 'outer');
  });

  test('restores the previous overlay when the topmost overlay unregisters', () => {
    __registerOverlayForTests('outer');
    __registerOverlayForTests('inner');

    __unregisterOverlayForTests('inner');

    assert.equal(__getTopOverlayIdForTests(), 'outer');
  });

  test('clears the topmost overlay when the last overlay unregisters', () => {
    __registerOverlayForTests('only');

    __unregisterOverlayForTests('only');

    assert.equal(__getTopOverlayIdForTests(), null);
  });
});

describe('overlay dismiss policies', () => {
  test('uses modal dismissal defaults by default', () => {
    assert.deepEqual(resolveOverlayDismissOptions({}), {
      closeOnBackdropPress: true,
      closeOnEscape: true,
    });
  });

  test('disables backdrop dismissal for detail overlays while preserving Escape', () => {
    assert.deepEqual(resolveOverlayDismissOptions({ policy: 'detail' }), {
      closeOnBackdropPress: false,
      closeOnEscape: true,
    });
  });

  test('allows explicit overrides on top of policy defaults', () => {
    assert.deepEqual(resolveOverlayDismissOptions({
      policy: 'detail',
      closeOnBackdropPress: true,
      closeOnEscape: false,
    }), {
      closeOnBackdropPress: true,
      closeOnEscape: false,
    });
  });
});
