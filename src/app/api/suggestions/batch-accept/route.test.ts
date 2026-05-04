import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { normalizeBatchCodeFixSuggestionStatus } from './route';

describe('batch code-fix accept response status', () => {
  test('preserves running status for duplicate approvals with an active task', () => {
    assert.equal(
      normalizeBatchCodeFixSuggestionStatus({ suggestionStatus: 'running' }),
      'running',
    );
  });

  test('preserves dispatched status for newly queued work', () => {
    assert.equal(
      normalizeBatchCodeFixSuggestionStatus({ suggestionStatus: 'dispatched' }),
      'dispatched',
    );
  });
});
