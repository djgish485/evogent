const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createCodexProvider } = require('./codex-provider');

const CODEX_BYPASS_APPROVALS_AND_SANDBOX_ARG = '--dangerously-bypass-approvals-and-sandbox';

function createProvider() {
  return createCodexProvider({}, {
    codexModel: 'gpt-5.5',
    codexReasoningEffort: 'medium',
  });
}

function withModelsCache(content, run) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-codex-models-'));
  const cachePath = path.join(tempDir, 'models_cache.json');
  fs.writeFileSync(cachePath, JSON.stringify(content), 'utf8');
  try {
    run(cachePath);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function getPromptArg(invocation) {
  return invocation.args[invocation.args.length - 1];
}

function getConfigValues(invocation) {
  const values = [];
  for (let index = 0; index < invocation.args.length; index += 1) {
    if (invocation.args[index] === '-c') {
      values.push(invocation.args[index + 1]);
    }
  }
  return values;
}

function assertResumeInvocationShape(invocation, sessionId) {
  assert.deepStrictEqual(invocation.args.slice(0, 2), ['exec', 'resume']);
  assert.ok(invocation.args.includes(CODEX_BYPASS_APPROVALS_AND_SANDBOX_ARG));
  assert.ok(!invocation.args.includes('-s'));
  assert.ok(!invocation.args.includes('danger-full-access'));
  assert.strictEqual(invocation.args[invocation.args.length - 2], sessionId);
  assert.strictEqual(getPromptArg(invocation), invocation.args[invocation.args.length - 1]);
}

test('user chat invocations prepend the conciseness overlay', () => {
  const provider = createProvider();

  const invocation = provider.buildInvocation({
    prompt: 'Answer the user',
    systemPrompt: 'System prompt',
    task: {
      priority: 'user_chat',
      metadata: null,
    },
    sessionMode: {
      mode: 'ephemeral',
    },
  });

  const fullPrompt = getPromptArg(invocation);
  assert.match(fullPrompt, /Lead with the answer or action, not the reasoning\./);
  assert.match(fullPrompt, /Prefer concise, information-dense writing\. Keep progress updates to 1-2 sentences\./);
  assert.match(fullPrompt, /Lead with the answer or action, not the reasoning\.[\s\S]*System prompt[\s\S]*Answer the user/);
});

test('non-chat invocations do not prepend the conciseness overlay', () => {
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

  assert.doesNotMatch(getPromptArg(invocation), /Lead with the answer or action, not the reasoning\./);
});

test('task metadata reasoning overrides the global Codex reasoning effort', () => {
  const provider = createProvider();

  const invocation = provider.buildInvocation({
    prompt: 'Do browser work',
    systemPrompt: 'System prompt',
    task: {
      priority: 'post_enrichment',
      metadata: {
        codexReasoningEffort: 'xhigh',
      },
    },
    sessionMode: {
      mode: 'ephemeral',
    },
  });

  const reasoningArg = invocation.args[invocation.args.indexOf('-c') + 1];
  assert.strictEqual(reasoningArg, 'model_reasoning_effort=xhigh');
});

test('codex invocations do not force stale context window overrides', () => {
  const provider = createProvider();

  const invocation = provider.buildInvocation({
    prompt: 'Do browser work',
    systemPrompt: 'System prompt',
    task: {
      priority: 'post_enrichment',
      metadata: {
        codexReasoningEffort: 'low',
      },
    },
    sessionMode: {
      mode: 'ephemeral',
    },
  });

  assert.deepStrictEqual(getConfigValues(invocation), [
    'model_reasoning_effort=low',
  ]);
});

test('Codex manual compaction stays disabled until the CLI exposes a real compaction entrypoint', () => {
  const provider = createProvider();

  assert.equal(provider.supportsManualCompaction(), false);
  assert.equal(typeof provider.buildCompactionInvocation, 'undefined');
});

test('codex fast mode metadata adds the fast service tier only when enabled', () => {
  const provider = createProvider();

  const enabled = provider.buildInvocation({
    prompt: 'Answer quickly',
    systemPrompt: 'System prompt',
    task: {
      priority: 'user_chat',
      metadata: {
        codexReasoningEffort: 'xhigh',
        codexFastMode: true,
      },
    },
    sessionMode: {
      mode: 'ephemeral',
    },
  });
  assert.ok(getConfigValues(enabled).includes('model_reasoning_effort=xhigh'));
  assert.ok(getConfigValues(enabled).includes('service_tier="fast"'));

  const disabled = provider.buildInvocation({
    prompt: 'Answer normally',
    systemPrompt: 'System prompt',
    task: {
      priority: 'user_chat',
      metadata: {
        codexFastMode: false,
      },
    },
    sessionMode: {
      mode: 'ephemeral',
    },
  });
  assert.ok(!getConfigValues(disabled).includes('service_tier="fast"'));

  const unset = provider.buildInvocation({
    prompt: 'Answer normally',
    systemPrompt: 'System prompt',
    task: {
      priority: 'user_chat',
      metadata: null,
    },
    sessionMode: {
      mode: 'ephemeral',
    },
  });
  assert.ok(!getConfigValues(unset).includes('service_tier="fast"'));
});

test('cache refresh tasks floor Codex reasoning to medium', () => {
  const provider = createCodexProvider({}, {
    codexModel: 'gpt-5.5',
    codexReasoningEffort: 'high',
  });

  const invocation = provider.buildInvocation({
    prompt: 'Refresh the browser cache',
    systemPrompt: 'System prompt',
    task: {
      priority: 'cache_refresh',
      metadata: null,
    },
    sessionMode: {
      mode: 'ephemeral',
    },
  });

  const reasoningArg = invocation.args[invocation.args.indexOf('-c') + 1];
  assert.strictEqual(reasoningArg, 'model_reasoning_effort=medium');
});

test('post enrichment tasks floor Codex reasoning to medium', () => {
  const provider = createCodexProvider({}, {
    codexModel: 'gpt-5.5',
    codexReasoningEffort: 'xhigh',
  });

  const invocation = provider.buildInvocation({
    prompt: 'Enrich a post',
    systemPrompt: 'System prompt',
    task: {
      priority: 'post_enrichment',
      metadata: null,
    },
    sessionMode: {
      mode: 'ephemeral',
    },
  });

  const reasoningArg = invocation.args[invocation.args.indexOf('-c') + 1];
  assert.strictEqual(reasoningArg, 'model_reasoning_effort=medium');
});

test('non-downshifted Codex tasks keep the configured reasoning effort', () => {
  const provider = createCodexProvider({}, {
    codexModel: 'gpt-5.5',
    codexReasoningEffort: 'xhigh',
  });

  for (const priority of ['user_chat', 'user_ping', 'heartbeat', 'reflection']) {
    const invocation = provider.buildInvocation({
      prompt: 'Do regular work',
      systemPrompt: 'System prompt',
      task: {
        priority,
        metadata: null,
      },
      sessionMode: {
        mode: 'ephemeral',
      },
    });

    const reasoningArg = invocation.args[invocation.args.indexOf('-c') + 1];
    assert.strictEqual(reasoningArg, 'model_reasoning_effort=xhigh', priority);
  }
});

test('resumed fast-mode Codex invocations use resume-compatible sandbox bypass args', () => {
  const provider = createProvider();
  const heartbeatSessionId = 'd29614ed-ffb8-42e0-a900-9718781418d7';
  const userChatSessionId = 'b83c4744-83d9-47bb-9988-54c51c4567ff';

  const heartbeatInvocation = provider.buildInvocation({
    prompt: '/curate',
    systemPrompt: 'System prompt',
    task: {
      priority: 'heartbeat',
      metadata: {
        codexFastMode: true,
      },
    },
    sessionMode: {
      mode: 'resume',
      sessionId: heartbeatSessionId,
    },
  });

  assertResumeInvocationShape(heartbeatInvocation, heartbeatSessionId);
  assert.match(getPromptArg(heartbeatInvocation), /System prompt[\s\S]*\/curate/);
  assert.deepStrictEqual(getConfigValues(heartbeatInvocation), [
    'model_reasoning_effort=medium',
    'service_tier="fast"',
  ]);

  const userChatInvocation = provider.buildInvocation({
    prompt: 'Answer the resumed chat',
    systemPrompt: 'System prompt',
    task: {
      priority: 'user_chat',
      metadata: {
        codexFastMode: true,
      },
    },
    sessionMode: {
      mode: 'resume',
      sessionId: userChatSessionId,
    },
  });

  assertResumeInvocationShape(userChatInvocation, userChatSessionId);
  assert.match(getPromptArg(userChatInvocation), /Lead with the answer or action, not the reasoning\./);
  assert.match(getPromptArg(userChatInvocation), /System prompt[\s\S]*Answer the resumed chat/);
  assert.ok(getConfigValues(userChatInvocation).includes('service_tier="fast"'));
});

test('Codex context metrics use token_count live input tokens and reported window', () => {
  const provider = createProvider();

  assert.deepStrictEqual(provider.extractContextMetrics({
    type: 'token_count',
    last_token_usage: {
      input_tokens: 177_111,
      cached_input_tokens: 900_000,
    },
    model_context_window: 258_400,
  }), {
    modelId: 'gpt-5.5',
    contextTokens: 177_111,
    contextWindow: 258_400,
    replaceContextTokens: true,
  });
});

test('Codex context metrics fall back to the effective models cache window', () => {
  withModelsCache({
    models: [
      {
        slug: 'gpt-5.5',
        context_window: 272_000,
        effective_context_window_percent: 95,
      },
    ],
  }, (cachePath) => {
    const provider = createCodexProvider({ codexModelsCachePath: cachePath }, {
      codexModel: 'gpt-5.5',
      codexReasoningEffort: 'medium',
    });

    assert.deepStrictEqual(provider.extractContextMetrics({
      type: 'token_count',
      last_token_usage: {
        input_tokens: 177_111,
      },
    }), {
      modelId: 'gpt-5.5',
      contextTokens: 177_111,
      contextWindow: 258_400,
      replaceContextTokens: true,
    });
  });
});

test('Codex cumulative turn.completed usage is not treated as live context', () => {
  const provider = createProvider();

  assert.strictEqual(provider.extractContextMetrics({
    type: 'turn.completed',
    usage: {
      input_tokens: 1_907_408,
      cached_input_tokens: 1_624_192,
      output_tokens: 25_000,
    },
  }), null);
});

test('Codex auto-compaction events are surfaced as automatic compaction metadata', () => {
  const provider = createProvider();
  const event = {
    type: 'context_compacted',
    pre_tokens: 245_000,
    post_tokens: 91_000,
  };

  assert.deepStrictEqual(provider.extractCompactionMetrics(event), {
    preTokens: 245_000,
    postTokens: 91_000,
    automatic: true,
  });
  assert.deepStrictEqual(provider.formatTranscriptLines(event), [
    '[context] compacted automatically to 91000 tokens',
  ]);
});

test('installed Codex resume help exposes the provider sandbox bypass flag', (t) => {
  const result = spawnSync('codex', ['exec', 'resume', '--help'], {
    encoding: 'utf8',
  });

  if (result.error?.code === 'ENOENT') {
    t.skip('codex CLI is not installed');
    return;
  }

  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(CODEX_BYPASS_APPROVALS_AND_SANDBOX_ARG));
  assert.doesNotMatch(result.stdout, /^\s+-s, --sandbox\b/m);
});
