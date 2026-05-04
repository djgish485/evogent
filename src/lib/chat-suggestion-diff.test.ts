import assert from 'node:assert';
import { describe, test } from 'node:test';
import { applyChatSuggestionDiff } from './chat-suggestion-diff';

describe('applyChatSuggestionDiff', () => {
  test('applies append-only diffs using the last context line as insertion anchor', () => {
    const content = [
      '## Analysis Style Preferences',
      '',
      '- Write with confidence, not hedging.',
    ].join('\n');

    const diff = [
      '--- data/curation-prompt.md',
      '+++ data/curation-prompt.md',
      '@@ -3,1 +3,10 @@',
      ' - Write with confidence, not hedging.',
      '+',
      '+## Per-Cycle Volume & Balance',
      '+',
      '+Each curation cycle should aim for roughly:',
      '+- **5-6 tweets on Iran / Middle East**',
      '+- **5-6 tweets across other interests**',
      '+- **1-2 articles**',
      '+- **1 original analysis**',
      '+',
      '+Do NOT let any single topic consume the entire feed.',
    ].join('\n');

    const result = applyChatSuggestionDiff(content, diff);

    assert.strictEqual(result.changed, true);
    assert.ok(result.content.includes('- Write with confidence, not hedging.\n\n## Per-Cycle Volume & Balance'));
    assert.ok(result.content.includes('Do NOT let any single topic consume the entire feed.'));
  });

  test('keeps existing replacement behavior for non-append diffs', () => {
    const content = ['alpha', 'beta', 'gamma'].join('\n');
    const diff = ['--- a/file.md', '+++ b/file.md', '@@', '-beta', '+delta'].join('\n');

    const result = applyChatSuggestionDiff(content, diff);

    assert.strictEqual(result.changed, true);
    assert.strictEqual(result.content, ['alpha', 'delta', 'gamma'].join('\n'));
  });

  test('returns unchanged when append-only diff has no matching context', () => {
    const content = '- Different line';
    const diff = [
      '--- data/curation-prompt.md',
      '+++ data/curation-prompt.md',
      '@@ -1,1 +1,2 @@',
      ' - Write with confidence, not hedging.',
      '+',
      '+## Per-Cycle Volume & Balance',
    ].join('\n');

    const result = applyChatSuggestionDiff(content, diff);
    assert.deepStrictEqual(result, { content, changed: false });
  });
});
