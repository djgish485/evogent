import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { buildSearchSnippet } from './search-utils';

describe('buildSearchSnippet', () => {
  test('can prefer the last matching occurrence', () => {
    const text = [
      'alpha appears near the beginning with some context.',
      'Then the body continues for a while without the term.',
      'Finally alpha appears near the end where the user probably expects to land.',
    ].join(' ');

    const first = buildSearchSnippet(text, 'alpha', 72);
    const last = buildSearchSnippet(text, 'alpha', 72, { prefer: 'last' });

    assert.equal(first.hasMatch, true);
    assert.equal(last.hasMatch, true);
    assert.match(first.text, /near the beginning/);
    assert.match(last.text, /near the end/);
  });
});
