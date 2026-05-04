import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { scrollSearchHighlightIntoView } from './search-detail-scroll';

describe('scrollSearchHighlightIntoView', () => {
  test('scrolls the first stable search highlight selector into view', () => {
    let selector = '';
    let options: ScrollIntoViewOptions | null = null;
    const root = {
      querySelector(input: string) {
        selector = input;
        return {
          scrollIntoView(inputOptions: ScrollIntoViewOptions) {
            options = inputOptions;
          },
        };
      },
    } as unknown as ParentNode;

    assert.equal(scrollSearchHighlightIntoView(root), true);
    assert.match(selector, /data-search-highlight/);
    assert.deepEqual(options, { block: 'center', behavior: 'auto' });
  });

  test('returns false when there is no highlighted match', () => {
    const root = {
      querySelector() {
        return null;
      },
    } as unknown as ParentNode;

    assert.equal(scrollSearchHighlightIntoView(root), false);
  });
});
