import assert from 'node:assert';
import { describe, test } from 'node:test';
import {
  applySuggestionProgrammatic,
  applyUnifiedDiff,
  replaceSectionContent,
} from '@/lib/suggestion-apply';

describe('suggestion-apply', () => {
  test('applyUnifiedDiff preserves append-only behavior with context anchor', () => {
    const content = [
      '## Analysis Style Preferences',
      '',
      '- Write with confidence, not hedging.',
    ].join('\n');

    const diff = [
      '--- data/curation-prompt.md',
      '+++ data/curation-prompt.md',
      '@@ -3,1 +3,5 @@',
      ' - Write with confidence, not hedging.',
      '+',
      '+## Per-Cycle Volume & Balance',
      '+',
      '+Do NOT let any single topic consume the entire feed.',
    ].join('\n');

    const result = applyUnifiedDiff(content, diff);
    assert.strictEqual(result.changed, true);
    assert.ok(result.content.includes('## Per-Cycle Volume & Balance'));
  });

  test('applyUnifiedDiff uses hunk line numbers for markdown bullet replacements', () => {
    const content = [
      '# Prompt',
      '',
      '## Per-Cycle Volume & Balance',
      '',
      '- **4-5 tweets on Iran / Middle East** — breaking developments',
      '- **4-5 tweets across other interests**',
      '- **1-2 articles**',
    ].join('\n');

    const diff = [
      '--- data/curation-prompt.md',
      '+++ data/curation-prompt.md',
      '@@ -5,1 +5,1 @@',
      '- **4-5 tweets on Iran / Middle East** — breaking developments',
      '+- **5-6 tweets on Iran / Middle East** — breaking developments',
    ].join('\n');

    const result = applyUnifiedDiff(content, diff);

    assert.strictEqual(result.changed, true);
    assert.ok(result.content.includes('- **5-6 tweets on Iran / Middle East** — breaking developments'));
    assert.ok(!result.content.includes('- **4-5 tweets on Iran / Middle East** — breaking developments'));
    assert.ok(result.content.includes('- **4-5 tweets across other interests**'));
  });

  test('replaceSectionContent replaces section body instead of appending list entries', () => {
    const content = [
      '# Prompt',
      '',
      '## Per-Cycle Volume & Balance',
      '',
      '- **8-10 tweets on Iran**',
      '',
      '## Suggested Search Strategies',
      '',
      '- Start from Home + Following feeds',
    ].join('\n');

    const proposed = [
      '## Per-Cycle Volume & Balance',
      '',
      'Each curation cycle should aim for roughly:',
      '- **5-6 tweets on Iran / Middle East**',
      '- **5-6 tweets across other interests**',
      '- **1-2 articles**',
    ].join('\n');

    const result = replaceSectionContent(content, 'Per-Cycle Volume & Balance', proposed);
    assert.strictEqual(result.changed, true);
    assert.strictEqual(result.appended, false);
    assert.strictEqual(result.content.match(/## Per-Cycle Volume & Balance/g)?.length, 1);
    assert.ok(result.content.includes('- **5-6 tweets across other interests**'));
    assert.ok(!result.content.includes('- **8-10 tweets on Iran**'));
  });

  test('applySuggestionProgrammatic uses section replacement when sectionName/proposedValue are provided', () => {
    const content = [
      '## Usage Level',
      '',
      'Medium',
      '',
      '## Curation Schedule',
      '',
      '- Minimum interval: 2 hours',
    ].join('\n');

    const result = applySuggestionProgrammatic(content, {
      sectionName: 'Usage Level',
      proposedValue: 'High',
    });

    assert.strictEqual(result.changed, true);
    assert.strictEqual(result.method, 'section-replace');
    assert.ok(result.content.includes('## Usage Level\n\nHigh'));
  });

  test('applySuggestionProgrammatic appends a new section when it does not exist', () => {
    const content = '# Prompt\n';
    const proposedValue = [
      '## New Section',
      '',
      '- New entry',
    ].join('\n');

    const result = applySuggestionProgrammatic(content, {
      sectionName: 'New Section',
      proposedValue,
    });

    assert.strictEqual(result.changed, true);
    assert.strictEqual(result.method, 'section-append');
    assert.ok(result.content.includes('## New Section'));
  });

  test('replaceSectionContent adds section header when appending plain values', () => {
    const content = '# Prompt\n';
    const result = replaceSectionContent(content, 'Usage Level', 'High');
    assert.strictEqual(result.changed, true);
    assert.strictEqual(result.appended, true);
    assert.ok(result.content.includes('## Usage Level\n\nHigh'));
  });

  test('applySuggestionProgrammatic reports method none when no strategy applies', () => {
    const content = 'unchanged';
    const result = applySuggestionProgrammatic(content, {});
    assert.deepStrictEqual(result, { content, changed: false, method: 'none' });
  });
});
