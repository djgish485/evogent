import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EMBEDDING_DIM,
  cosineSimilarity,
  hashEmbedding,
  selectEmbeddingBackend,
} from './embeddings';

test('Android selects the deterministic dependency-free embedding backend', () => {
  assert.equal(selectEmbeddingBackend('android'), 'hash');
  assert.equal(selectEmbeddingBackend('linux', 'hash'), 'hash');
  assert.equal(selectEmbeddingBackend('darwin'), 'local-model');
});

test('hash embeddings are stable, normalized, and similarity-preserving', () => {
  const first = hashEmbedding('durable private phone runtime');
  const same = hashEmbedding('durable private phone runtime');
  const related = hashEmbedding('private phone runtime durability');
  const unrelated = hashEmbedding('cooking citrus dessert');

  assert.equal(first.length, EMBEDDING_DIM);
  assert.deepEqual(first, same);
  const magnitude = Math.sqrt(first.reduce((sum, value) => sum + value * value, 0));
  assert.ok(Math.abs(magnitude - 1) < 1e-9);
  assert.ok(cosineSimilarity(first, related) > cosineSimilarity(first, unrelated));
});
