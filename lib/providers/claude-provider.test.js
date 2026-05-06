/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const test = require('node:test');
const { createClaudeProvider } = require('./claude-provider');

function getFlagValue(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1 || index === args.length - 1) {
    return null;
  }

  return args[index + 1] || null;
}

function createProvider(brainConfig = {}) {
  return createClaudeProvider({
    DEFAULT_CLAUDE_ALLOWED_TOOLS: 'Bash,Edit,Read,Write,Glob,Grep,WebFetch,WebSearch',
    DEFAULT_CLAUDE_CURATION_ALLOWED_TOOLS: 'Bash,Edit,Read,Write,Glob,Grep,WebFetch,WebSearch,Browser',
    DEFAULT_CLAUDE_PERMISSION_MODE: 'dontAsk',
    collectAssistantText: () => [],
    extractChatProgressFromEvent: () => null,
    extractFinalResultText: () => null,
    extractSessionIdFromStreamEvent: () => null,
    extractStreamingChatTextFromEvent: () => null,
    formatTranscriptLines: () => [],
    isCurationTask: () => false,
    isFreshAssistantStreamingSignal: () => false,
    summarizeStreamingChatEvent: () => null,
  }, brainConfig);
}

function buildCacheRefreshInvocation(brainConfig = {}) {
  return createProvider(brainConfig).buildInvocation({
    prompt: 'Do the browser cache work',
    systemPrompt: 'System prompt',
    task: {
      priority: 'cache_refresh',
      metadata: {
        claudeReasoningEffort: 'max',
      },
    },
    sessionMode: {
      mode: 'ephemeral',
    },
  });
}

test('task-backed invocations ignore local Claude settings restrictions', () => {
  const provider = createProvider();

  const invocation = provider.buildInvocation({
    prompt: 'Do the work',
    systemPrompt: 'System prompt',
    task: {
      priority: 'heartbeat',
      metadata: null,
    },
    sessionMode: {
      mode: 'ephemeral',
    },
  });

  assert.equal(getFlagValue(invocation.args, '--setting-sources'), 'user,project');
  assert.equal(getFlagValue(invocation.args, '--permission-mode'), 'dontAsk');
});

test('non-task invocations keep the configured permission mode', () => {
  const provider = createProvider();

  const invocation = provider.buildInvocation({
    prompt: 'Do the work',
    systemPrompt: 'System prompt',
    task: {},
    sessionMode: {
      mode: 'ephemeral',
    },
  });

  assert.equal(getFlagValue(invocation.args, '--setting-sources'), null);
  assert.equal(getFlagValue(invocation.args, '--permission-mode'), 'dontAsk');
});

test('task-backed invocations do not force the attached Chrome extension path', () => {
  const provider = createProvider();

  const invocation = provider.buildInvocation({
    prompt: 'Do the browser work',
    systemPrompt: 'System prompt',
    task: {
      priority: 'post_enrichment',
      metadata: {
        requiresBrowserTools: true,
        useAttachedChrome: true,
      },
    },
    sessionMode: {
      mode: 'ephemeral',
    },
  });

  assert.equal(getFlagValue(invocation.args, '--allowedTools'), 'Bash,Edit,Read,Write,Glob,Grep,WebFetch,WebSearch,Browser');
  assert.ok(!invocation.args.includes('--chrome'));
});

test('cache refresh tasks use browser tools and Sonnet 4.6', () => {
  const invocation = buildCacheRefreshInvocation();

  assert.equal(getFlagValue(invocation.args, '--allowedTools'), 'Bash,Edit,Read,Write,Glob,Grep,WebFetch,WebSearch,Browser');
  assert.equal(getFlagValue(invocation.args, '--model'), 'claude-sonnet-4-6');
});

test('cache refresh effort comes from brain config with high fallback', () => {
  for (const { brainConfig, expected } of [
    { brainConfig: { cacheRefreshEffort: 'low' }, expected: 'low' },
    { brainConfig: { cacheRefreshEffort: 'high' }, expected: 'high' },
    { brainConfig: {}, expected: 'high' },
  ]) {
    const invocation = buildCacheRefreshInvocation(brainConfig);

    assert.equal(getFlagValue(invocation.args, '--effort'), expected);
  }
});

test('post enrichment tasks use Sonnet 4.6 high effort', () => {
  const provider = createClaudeProvider({
    DEFAULT_CLAUDE_ALLOWED_TOOLS: 'Bash,Edit,Read,Write,Glob,Grep,WebFetch,WebSearch',
    DEFAULT_CLAUDE_CURATION_ALLOWED_TOOLS: 'Bash,Edit,Read,Write,Glob,Grep,WebFetch,WebSearch,Browser',
    DEFAULT_CLAUDE_PERMISSION_MODE: 'dontAsk',
    collectAssistantText: () => [],
    extractChatProgressFromEvent: () => null,
    extractFinalResultText: () => null,
    extractSessionIdFromStreamEvent: () => null,
    extractStreamingChatTextFromEvent: () => null,
    formatTranscriptLines: () => [],
    isCurationTask: () => false,
    isFreshAssistantStreamingSignal: () => false,
    summarizeStreamingChatEvent: () => null,
  }, {
    claudeReasoningEffort: 'medium',
  });

  const invocation = provider.buildInvocation({
    prompt: 'Enrich the feed item',
    systemPrompt: 'System prompt',
    task: {
      priority: 'post_enrichment',
      metadata: {
        claudeReasoningEffort: 'max',
      },
    },
    sessionMode: {
      mode: 'ephemeral',
    },
  });

  assert.equal(getFlagValue(invocation.args, '--model'), 'claude-sonnet-4-6');
  assert.equal(getFlagValue(invocation.args, '--effort'), 'high');
});

test('non-cache runtime tasks keep Opus 4.7 routing', () => {
  const provider = createClaudeProvider({
    DEFAULT_CLAUDE_ALLOWED_TOOLS: 'Bash,Edit,Read,Write,Glob,Grep,WebFetch,WebSearch',
    DEFAULT_CLAUDE_CURATION_ALLOWED_TOOLS: 'Bash,Edit,Read,Write,Glob,Grep,WebFetch,WebSearch,Browser',
    DEFAULT_CLAUDE_PERMISSION_MODE: 'dontAsk',
    collectAssistantText: () => [],
    extractChatProgressFromEvent: () => null,
    extractFinalResultText: () => null,
    extractSessionIdFromStreamEvent: () => null,
    extractStreamingChatTextFromEvent: () => null,
    formatTranscriptLines: () => [],
    isCurationTask: () => false,
    isFreshAssistantStreamingSignal: () => false,
    summarizeStreamingChatEvent: () => null,
  }, {
    claudeReasoningEffort: 'medium',
  });

  for (const priority of ['user_chat', 'user_ping', 'heartbeat']) {
    const invocation = provider.buildInvocation({
      prompt: 'Do the work',
      systemPrompt: 'System prompt',
      task: {
        priority,
        metadata: null,
      },
      sessionMode: {
        mode: 'ephemeral',
      },
    });

    assert.equal(getFlagValue(invocation.args, '--model'), 'claude-opus-4-7[1m]', priority);
    assert.equal(getFlagValue(invocation.args, '--effort'), 'medium', priority);
  }
});

test('non-cache runtime tasks use configured curator model', () => {
  const provider = createProvider({
    claudeReasoningEffort: 'medium',
    curatorModel: 'claude-opus-4-7',
  });

  for (const priority of ['user_chat', 'user_ping', 'heartbeat']) {
    const invocation = provider.buildInvocation({
      prompt: 'Do the work',
      systemPrompt: 'System prompt',
      task: {
        priority,
        metadata: null,
      },
      sessionMode: {
        mode: 'ephemeral',
      },
    });

    assert.equal(getFlagValue(invocation.args, '--model'), 'claude-opus-4-7', priority);
    assert.equal(getFlagValue(invocation.args, '--effort'), 'medium', priority);
  }
});

test('task metadata reasoning overrides the global Claude reasoning effort', () => {
  const provider = createClaudeProvider({
    DEFAULT_CLAUDE_ALLOWED_TOOLS: 'Bash,Edit,Read,Write,Glob,Grep,WebFetch,WebSearch',
    DEFAULT_CLAUDE_CURATION_ALLOWED_TOOLS: 'Bash,Edit,Read,Write,Glob,Grep,WebFetch,WebSearch,Browser',
    DEFAULT_CLAUDE_PERMISSION_MODE: 'dontAsk',
    collectAssistantText: () => [],
    extractChatProgressFromEvent: () => null,
    extractFinalResultText: () => null,
    extractSessionIdFromStreamEvent: () => null,
    extractStreamingChatTextFromEvent: () => null,
    formatTranscriptLines: () => [],
    isCurationTask: () => false,
    isFreshAssistantStreamingSignal: () => false,
    summarizeStreamingChatEvent: () => null,
  }, {
    claudeReasoningEffort: 'medium',
  });

  const invocation = provider.buildInvocation({
    prompt: 'Do the work',
    systemPrompt: 'System prompt',
    task: {
      priority: 'user_chat',
      metadata: {
        claudeReasoningEffort: 'max',
      },
    },
    sessionMode: {
      mode: 'ephemeral',
    },
  });

  assert.equal(getFlagValue(invocation.args, '--model'), 'claude-opus-4-7[1m]');
  assert.equal(getFlagValue(invocation.args, '--effort'), 'max');
});

test('session poisoning errors include already-in-use failures', () => {
  const provider = createProvider();

  assert.equal(
    provider.isSessionPoisoningError('Session ID 7b364... is already in use'),
    true,
  );
});

test('session poisoning treats Claude API 500s as fatal only after partial progress', () => {
  const provider = createProvider();

  assert.equal(
    provider.isSessionPoisoningError('API Error: 500 Internal Server Error', {
      hadToolUse: true,
      hadPartialProgress: true,
    }),
    true,
  );
  assert.equal(
    provider.isSessionPoisoningError('API Error: 500 Internal Server Error', {
      hadToolUse: false,
      hadPartialProgress: false,
    }),
    false,
  );
});

test('context metrics use the first assistant usage instead of cumulative result usage', () => {
  const provider = createProvider();

  assert.deepEqual(
    provider.extractContextMetrics({
      type: 'assistant',
      message: {
        model: 'claude-opus-4-7',
        usage: {
          input_tokens: 12,
          cache_read_input_tokens: 340,
          cache_creation_input_tokens: 48,
        },
      },
    }),
    {
      modelId: 'claude-opus-4-7',
      contextTokens: 400,
      contextWindow: null,
      usageSource: 'assistant',
      inputTokens: 12,
      outputTokens: 0,
      cacheReadTokens: 340,
      cacheCreateTokens: 48,
    },
  );
});

test('result events contribute Claude context window metadata and final token totals', () => {
  const provider = createProvider();

  assert.deepEqual(
    provider.extractContextMetrics({
      type: 'result',
      modelUsage: {
        'claude-opus-4-7[1m]': {
          inputTokens: 22,
          outputTokens: 123,
          cacheReadInputTokens: 3955103,
          cacheCreationInputTokens: 205936,
          contextWindow: 1_000_000,
        },
      },
    }),
    {
      modelId: 'claude-opus-4-7[1m]',
      contextWindow: 1_000_000,
      usageSource: 'result',
      inputTokens: 22,
      outputTokens: 123,
      cacheReadTokens: 3955103,
      cacheCreateTokens: 205936,
    },
  );
});
