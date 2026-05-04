import assert from 'node:assert';
import { describe, test } from 'node:test';
import { extractStreamingChatTextFromEvent } from './chat-streaming.js';

describe('chat streaming extraction', () => {
  test('streams partial chat text from Write tool input deltas', () => {
    const toolUseBlocks = new Map<number, { toolName: string; partialInputJson: string }>();

    assert.strictEqual(extractStreamingChatTextFromEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          name: 'Write',
        },
      },
    }, toolUseBlocks), null);

    assert.strictEqual(extractStreamingChatTextFromEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'input_json_delta',
          partial_json: '{"file_path":"/tmp/chat-output.jsonl","content":"{\\"type\\":\\"chat\\",\\"text\\":\\"Hel',
        },
      },
    }, toolUseBlocks), 'Hel');

    assert.strictEqual(extractStreamingChatTextFromEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'input_json_delta',
          partial_json: 'lo\\\\nworld',
        },
      },
    }, toolUseBlocks), 'Hello\nworld');

    assert.strictEqual(extractStreamingChatTextFromEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'input_json_delta',
          partial_json: '\\"}\\\\n"}',
        },
      },
    }, toolUseBlocks), 'Hello\nworld');
  });

  test('streams chat text from Bash tool command deltas before the file path appears', () => {
    const toolUseBlocks = new Map<number, { toolName: string; partialInputJson: string }>();

    extractStreamingChatTextFromEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          name: 'Bash',
        },
      },
    }, toolUseBlocks);

    assert.strictEqual(extractStreamingChatTextFromEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'input_json_delta',
          partial_json: '{"command":"printf \'{\\"type\\":\\"chat\\",\\"text\\":\\"Partial',
        },
      },
    }, toolUseBlocks), 'Partial');

    assert.strictEqual(extractStreamingChatTextFromEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'input_json_delta',
          partial_json: ' reply\\"}\\\\n\' >> /app/data/chat-output.jsonl"}',
        },
      },
    }, toolUseBlocks), 'Partial reply');
  });

  test('falls back to complete assistant tool_use payloads', () => {
    const text = extractStreamingChatTextFromEvent({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Write',
            input: {
              file_path: '/tmp/chat-output.jsonl',
              content: '{"type":"chat","text":"Final streamed reply"}\n',
            },
          },
        ],
      },
    }, new Map());

    assert.strictEqual(text, 'Final streamed reply');
  });

  test('ignores stale payloads for a different reply target when the current inReplyTo is known', () => {
    const toolUseBlocks = new Map<number, { toolName: string; partialInputJson: string }>();

    extractStreamingChatTextFromEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          name: 'Write',
        },
      },
    }, toolUseBlocks, 'msg-current');

    const text = extractStreamingChatTextFromEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'input_json_delta',
          partial_json: '{"content":"{\\"type\\":\\"chat\\",\\"inReplyTo\\":\\"msg-old\\",\\"text\\":\\"Old answer\\"}\\n{\\"type\\":\\"chat\\",\\"inReplyTo\\":\\"msg-current\\",\\"text\\":\\"New ans',
        },
      },
    }, toolUseBlocks, 'msg-current');

    assert.strictEqual(text, 'New ans');
  });

  test('extracts chat text from nested edit payloads', () => {
    const text = extractStreamingChatTextFromEvent({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'MultiEdit',
            input: {
              file_path: '/tmp/chat-output.jsonl',
              edits: [
                {
                  old_string: '',
                  new_string: '{"type":"chat","text":"Nested streamed reply"}\n',
                },
              ],
            },
          },
        ],
      },
    }, new Map());

    assert.strictEqual(text, 'Nested streamed reply');
  });

  test('ignores unrelated tool-use JSON payloads', () => {
    const toolUseBlocks = new Map<number, { toolName: string; partialInputJson: string }>();

    extractStreamingChatTextFromEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 1,
        content_block: {
          type: 'tool_use',
          name: 'Write',
        },
      },
    }, toolUseBlocks);

    const text = extractStreamingChatTextFromEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 1,
        delta: {
          type: 'input_json_delta',
          partial_json: '{"file_path":"/tmp/config.json","content":"{\\"text\\":\\"not a chat payload\\"}"}',
        },
      },
    }, toolUseBlocks);

    assert.strictEqual(text, null);
  });
});
