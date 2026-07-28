import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, test } from 'node:test';

const require = createRequire(import.meta.url);
const {
  buildProviderChildEnv,
  buildTransientScreenContextSystemPrompt,
  parseProviderStreamEvent,
  redactTransientScreenContext,
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

  test('redacts raw and JSON-escaped transient screen context from durable diagnostics', () => {
    const context = 'The user is viewing a reader. Visible screen content:\nPRIVATE_SCREEN_CANARY_1842';
    const jsonLine = JSON.stringify({
      type: 'user',
      message: `prefix ${context} suffix`,
    });

    const redacted = redactTransientScreenContext(jsonLine, context);
    assert.doesNotMatch(redacted, /PRIVATE_SCREEN_CANARY_1842/);
    assert.match(redacted, /screen context withheld/);
    assert.match(
      buildTransientScreenContextSystemPrompt(context),
      /PRIVATE_SCREEN_CANARY_1842/,
      'the provider-only prompt still receives the context in memory',
    );
  });

  test('provider child env keeps the scoped internal base URL but strips server auth', () => {
    const childEnv = buildProviderChildEnv({
      PATH: '/test/bin',
      MEDIA_AGENT_INTERNAL_BASE_URL: 'http://127.0.0.1:3001',
      EVOGENT_SERVER_LOOPBACK_SECRET: 'server-only-secret',
    }, {
      MEDIA_AGENT_TASK_ID: 'task-env-test',
      EVOGENT_SERVER_LOOPBACK_SECRET: 'must-not-be-reintroduced',
    });

    assert.strictEqual(childEnv.PATH, '/test/bin');
    assert.strictEqual(childEnv.MEDIA_AGENT_INTERNAL_BASE_URL, 'http://127.0.0.1:3001');
    assert.strictEqual(childEnv.MEDIA_AGENT_TASK_ID, 'task-env-test');
    assert.ok(!Object.hasOwn(childEnv, 'EVOGENT_SERVER_LOOPBACK_SECRET'));
  });
});
