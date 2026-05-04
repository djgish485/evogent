import assert from 'node:assert';
import { describe, test } from 'node:test';
import { normalizeAgentChatText } from './chat-text';

describe('normalizeAgentChatText', () => {
  test('preserves replies that already use real newlines', () => {
    const text = '## Plan\n- Inspect importer\n- Patch renderer';

    assert.strictEqual(normalizeAgentChatText(text), text);
  });

  test('decodes escaped newlines for clearly formatted replies', () => {
    assert.strictEqual(
      normalizeAgentChatText('## Plan\\n- Inspect importer\\n- Patch renderer'),
      '## Plan\n- Inspect importer\n- Patch renderer',
    );
    assert.strictEqual(
      normalizeAgentChatText('Paragraph one\\n\\nParagraph two'),
      'Paragraph one\n\nParagraph two',
    );
  });

  test('decodes escaped newlines for compact label-formatted review replies', () => {
    assert.strictEqual(
      normalizeAgentChatText('Review clean overall.\\nRequest fit: matches the task.\\nPhilosophy fit: no runtime workaround.\\nUnintended revert risk: none found.'),
      'Review clean overall.\nRequest fit: matches the task.\nPhilosophy fit: no runtime workaround.\nUnintended revert risk: none found.',
    );
  });

  test('preserves literal backslashes when escaped newlines are not formatting', () => {
    const text = 'Use \\n when documenting JSON strings or paths like C:\\new\\notes.';

    assert.strictEqual(normalizeAgentChatText(text), text);
  });
});
