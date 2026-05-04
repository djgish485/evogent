import assert from 'node:assert';
import { describe, test } from 'node:test';
import { extractChatProgressFromEvent, resolveToolProgress } from './chat-progress.js';

describe('chat progress extraction', () => {
  test('maps WebSearch tool starts to a user-facing activity', () => {
    const toolUseBlocks = new Map<number, { toolName: string; partialInputJson: string }>();

    const progress = extractChatProgressFromEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          name: 'WebSearch',
        },
      },
    }, toolUseBlocks);

    assert.deepStrictEqual(progress, {
      activity: 'Searching the web...',
      tool: 'WebSearch',
    });
  });

  test('upgrades Read activity once the filename appears in partial input json', () => {
    const toolUseBlocks = new Map<number, { toolName: string; partialInputJson: string }>();

    extractChatProgressFromEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 2,
        content_block: {
          type: 'tool_use',
          name: 'Read',
        },
      },
    }, toolUseBlocks);

    toolUseBlocks.set(2, {
      toolName: 'Read',
      partialInputJson: '{"file_path":"/root/evogent/server.js"',
    });

    const progress = extractChatProgressFromEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 2,
        delta: {
          type: 'input_json_delta',
          partial_json: '',
        },
      },
    }, toolUseBlocks);

    assert.deepStrictEqual(progress, {
      activity: 'Reading server.js...',
      tool: 'Read',
      target: '/root/evogent/server.js',
    });
  });

  test('maps Write tool progress to a user-facing activity', () => {
    const progress = resolveToolProgress('Write', {
      input: {
        file_path: '/root/evogent/data/chat-output.jsonl',
      },
    });

    assert.deepStrictEqual(progress, {
      activity: 'Writing chat-output.jsonl...',
      tool: 'Write',
      target: '/root/evogent/data/chat-output.jsonl',
    });
  });

  test('upgrades Write activity once the filename appears in partial input json', () => {
    const progress = resolveToolProgress('Write', {
      partialInputJson: '{"file_path":"/root/evogent/data/chat-output.jsonl"',
    });

    assert.deepStrictEqual(progress, {
      activity: 'Writing chat-output.jsonl...',
      tool: 'Write',
      target: '/root/evogent/data/chat-output.jsonl',
    });
  });

  test('maps text deltas to thinking progress', () => {
    const progress = extractChatProgressFromEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 1,
        delta: {
          type: 'text_delta',
          text: 'Considering options',
        },
      },
    }, new Map());

    assert.deepStrictEqual(progress, {
      activity: 'Thinking...',
      tool: 'Thinking',
    });
  });
});
