import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLimit, parseOffset, parseSearchQuery, parseSort, parseSourceFilter, parseTypeFilter } from './feed-query';

test('type filter accepts supported type values', () => {
  assert.deepEqual(parseTypeFilter('tweet,analysis,suggestion,notification,invalid'), ['tweet', 'analysis', 'suggestion', 'notification']);
});

test('source filter deduplicates values', () => {
  assert.deepEqual(parseSourceFilter('bbc,bbc,claude'), ['bbc', 'claude']);
});

test('offset and limit guards', () => {
  assert.equal(parseOffset('-10'), 0);
  assert.equal(parseOffset('7.9'), 7);
  assert.equal(parseLimit('1000'), 100);
  assert.equal(parseLimit('0'), 20);
});

test('sort defaults to created and accepts published', () => {
  assert.equal(parseSort(null), 'created');
  assert.equal(parseSort('created'), 'created');
  assert.equal(parseSort('published'), 'published');
  assert.equal(parseSort('PUBLISHED'), 'published');
  assert.equal(parseSort('invalid'), 'created');
});

test('search query trims and normalizes whitespace', () => {
  assert.equal(parseSearchQuery(null), null);
  assert.equal(parseSearchQuery('   '), null);
  assert.equal(parseSearchQuery('  climate    policy   updates  '), 'climate policy updates');
});
