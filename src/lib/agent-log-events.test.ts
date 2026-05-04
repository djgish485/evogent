import assert from 'node:assert';
import { describe, test } from 'node:test';
import {
  extractTranscriptTextFromAgentLogEvent,
  inferAgentOutcomeFromLogContent,
  parseAgentLogEvents,
} from '@/lib/agent-log-events';

describe('agent-log-events', () => {
  test('extracts Claude and Codex transcript text', () => {
    const claudeLines = extractTranscriptTextFromAgentLogEvent({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Claude transcript line.' },
        ],
      },
    });

    const codexLines = extractTranscriptTextFromAgentLogEvent({
      type: 'item.completed',
      item: {
        id: 'item_1',
        type: 'agent_message',
        text: 'Codex transcript line.',
      },
    });

    assert.deepStrictEqual(claudeLines, ['Claude transcript line.']);
    assert.deepStrictEqual(codexLines, ['Codex transcript line.']);
  });

  test('parses Codex command and message events', () => {
    const started = parseAgentLogEvents({
      type: 'item.started',
      item: {
        id: 'item_1',
        type: 'command_execution',
        command: '/bin/zsh -lc "rg -n \\"name\\" package.json"',
      },
    });
    const completed = parseAgentLogEvents({
      type: 'item.completed',
      item: {
        id: 'item_2',
        type: 'agent_message',
        text: 'The package name is evogent.',
      },
    });

    assert.strictEqual(started.length, 1);
    assert.strictEqual(started[0]?.type, 'tool_call');
    assert.strictEqual(started[0]?.toolName, 'command_execution');
    assert.ok(started[0]?.message?.includes('rg -n'));

    assert.strictEqual(completed.length, 1);
    assert.strictEqual(completed[0]?.type, 'text');
    assert.strictEqual(completed[0]?.message, 'The package name is evogent.');
  });

  test('infers outcomes from Claude and Codex log content', () => {
    const claudeOutcome = inferAgentOutcomeFromLogContent([
      JSON.stringify({ type: 'result', result: 'done', is_error: false }),
    ].join('\n'));

    const codexOutcome = inferAgentOutcomeFromLogContent([
      JSON.stringify({ type: 'thread.started', thread_id: 'thread_1' }),
      JSON.stringify({ type: 'turn.completed' }),
    ].join('\n'));

    assert.deepStrictEqual(claudeOutcome, {
      status: 'completed',
      exitCode: 0,
      error: null,
    });
    assert.deepStrictEqual(codexOutcome, {
      status: 'completed',
      exitCode: 0,
      error: null,
    });
  });
});
