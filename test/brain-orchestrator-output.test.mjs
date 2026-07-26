import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, test } from 'node:test';

const require = createRequire(import.meta.url);
const {
  parseProviderStreamEvent,
  selectBrainResponseText,
} = require('../lib/brain-orchestrator.js');

describe('brain provider output boundaries', () => {
  test('never interprets stderr as a provider event', () => {
    let parserCalls = 0;
    const parser = (line) => {
      parserCalls += 1;
      return { result: line };
    };

    assert.strictEqual(
      parseProviderStreamEvent('stderr', '{"result":"credential helper failed"}', parser),
      null,
    );
    assert.strictEqual(parserCalls, 0);
    assert.deepStrictEqual(
      parseProviderStreamEvent('stdout', '{"result":"real reply"}', parser),
      { result: '{"result":"real reply"}' },
    );
    assert.strictEqual(parserCalls, 1);
  });

  test('does not turn diagnostic-only output into a delivered chat response', () => {
    assert.strictEqual(selectBrainResponseText({
      finalResultText: '',
      streamedChatText: '',
      assistantTextParts: [],
      stdoutFallbackLines: [],
    }), null);
  });

  test('retains plain stdout as a compatibility fallback', () => {
    assert.strictEqual(selectBrainResponseText({
      finalResultText: '',
      streamedChatText: '',
      assistantTextParts: [],
      stdoutFallbackLines: ['plain provider reply'],
    }), 'plain provider reply');
  });
});
