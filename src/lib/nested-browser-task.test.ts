import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import {
  __testOnly,
  NestedBrowserTaskExecutionError,
  runNestedBrowserTask,
  runNestedBrowserTaskDetailed,
} from './nested-browser-task';

function getFlagValue(args: string[], flag: string) {
  const index = args.indexOf(flag);
  if (index === -1 || index === args.length - 1) {
    return null;
  }

  return args[index + 1] || null;
}

let tempDir = '';

function createCodexTestProvider() {
  return {
    name: 'codex' as const,
    displayName: 'Codex',
    binaryName: 'node',
    buildInvocation: () => {
      throw new Error('unused');
    },
    collectAssistantText: (rawEvent: unknown) => {
      const text = (rawEvent as { item?: { text?: unknown } })?.item?.text;
      return typeof text === 'string' && text ? [text] : [];
    },
    formatTranscriptLines: () => [],
    extractFinalResultText: (rawEvent: unknown) => {
      const text = (rawEvent as { item?: { text?: unknown } })?.item?.text;
      return typeof text === 'string' ? text : null;
    },
  };
}

function createClaudeTestProvider() {
  return {
    name: 'claude' as const,
    displayName: 'Claude',
    binaryName: 'node',
    buildInvocation: () => {
      throw new Error('unused');
    },
    collectAssistantText: (rawEvent: unknown) => {
      const text = (rawEvent as { delta?: { text?: unknown } })?.delta?.text;
      return typeof text === 'string' && text ? [text] : [];
    },
    formatTranscriptLines: () => [],
    extractFinalResultText: () => null,
  };
}

beforeEach(async () => {
  tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evogent-nested-browser-task-'));
});

afterEach(async () => {
  __testOnly.resetTestOverrides();

  if (tempDir) {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
    tempDir = '';
  }
});

test('buildNestedBrowserTaskInvocation selects the Claude browser path when Claude is configured', async () => {
  const configPath = path.join(tempDir, 'config-claude.md');
  await fs.promises.writeFile(configPath, [
    '# Evogent Config',
    '',
    '## Brain Provider',
    'Claude Code',
    '',
  ].join('\n'), 'utf8');

  const result = __testOnly.buildNestedBrowserTaskInvocation({
    prompt: 'Read the subscriptions page and return JSON.',
    configPath,
  });

  assert.equal(result.provider.name, 'claude');
  assert.equal(result.invocation.command, 'claude');
  assert.ok(!result.invocation.args.includes('--chrome'));
  assert.equal(
    getFlagValue(result.invocation.args, '--allowedTools'),
    'Browser,Bash,WebFetch,mcp__playwright__browser_navigate,mcp__playwright__browser_snapshot,mcp__playwright__browser_tabs,mcp__playwright__browser_click,mcp__playwright__browser_type,mcp__playwright__browser_fill_form,mcp__playwright__browser_evaluate,mcp__playwright__browser_press_key,mcp__playwright__browser_select_option,mcp__playwright__browser_hover,mcp__playwright__browser_wait_for',
  );
  assert.equal(getFlagValue(result.invocation.args, '--permission-mode'), 'dontAsk');
  assert.match(result.systemPrompt, /inspect the rendered result directly/i);
  assert.match(result.systemPrompt, /Use browser snapshots selectively/i);
  assert.match(result.systemPrompt, /Treat any requested item limit or count as the primary browsing budget/i);
  assert.doesNotMatch(result.systemPrompt, /Extract ALL qualifying items visible on each page/i);
  assert.doesNotMatch(result.systemPrompt, /capturing a browser snapshot of the rendered result before deciding what to do next/i);
});

test('buildNestedBrowserTaskInvocation marks cache browsing tasks for Claude Sonnet routing', async () => {
  const configPath = path.join(tempDir, 'config-claude-cache.md');
  await fs.promises.writeFile(configPath, [
    '# Evogent Config',
    '',
    '## Brain Provider',
    'Claude Code',
    '',
  ].join('\n'), 'utf8');

  const result = __testOnly.buildNestedBrowserTaskInvocation({
    prompt: 'Read the subscriptions page and return JSON.',
    configPath,
    isCacheBrowsingTask: true,
  });

  assert.equal(result.provider.name, 'claude');
  assert.equal(getFlagValue(result.invocation.args, '--model'), 'claude-sonnet-4-6');
  assert.equal(getFlagValue(result.invocation.args, '--effort'), 'high');
  assert.match(result.systemPrompt, /Extract ALL qualifying items visible on each page/i);
  assert.doesNotMatch(result.systemPrompt, /Treat any requested item limit or count as the primary browsing budget/i);
});

test('buildNestedBrowserTaskInvocation selects the Codex browser path when Codex is configured', async () => {
  const configPath = path.join(tempDir, 'config-codex.md');
  await fs.promises.writeFile(configPath, [
    '# Evogent Config',
    '',
    '## Brain Provider',
    'Codex CLI',
    '',
    '## Codex Reasoning Effort',
    'High',
    '',
  ].join('\n'), 'utf8');

  const result = __testOnly.buildNestedBrowserTaskInvocation({
    prompt: 'Read the subscriptions page and return JSON.',
    configPath,
  });

  assert.equal(result.provider.name, 'codex');
  assert.equal(result.invocation.command, 'codex');
  assert.deepEqual(result.invocation.args.slice(0, 2), ['exec', '--json']);
  assert.equal(getFlagValue(result.invocation.args, '--model'), 'gpt-5.5');
  assert.equal(getFlagValue(result.invocation.args, '-c'), 'model_reasoning_effort=low');
  assert.ok(!result.invocation.args.includes('--chrome'));
});

test('buildNestedBrowserTaskInvocation defaults Codex cache browsing tasks to medium reasoning', async () => {
  const configPath = path.join(tempDir, 'config-codex-cache.md');
  await fs.promises.writeFile(configPath, [
    '# Evogent Config',
    '',
    '## Brain Provider',
    'Codex CLI',
    '',
    '## Codex Reasoning Effort',
    'High',
    '',
  ].join('\n'), 'utf8');

  const result = __testOnly.buildNestedBrowserTaskInvocation({
    prompt: 'Refresh the tweet cache and persist rows.',
    configPath,
    isCacheBrowsingTask: true,
  });

  assert.equal(result.provider.name, 'codex');
  assert.equal(getFlagValue(result.invocation.args, '-c'), 'model_reasoning_effort=medium');
});

test('buildNestedBrowserTaskInvocation allows an explicit Codex reasoning override', async () => {
  const configPath = path.join(tempDir, 'config-codex-override.md');
  await fs.promises.writeFile(configPath, [
    '# Evogent Config',
    '',
    '## Brain Provider',
    'Codex CLI',
    '',
  ].join('\n'), 'utf8');

  const result = __testOnly.buildNestedBrowserTaskInvocation({
    prompt: 'Refresh the tweet cache and persist rows.',
    configPath,
    isCacheBrowsingTask: true,
    reasoningEffort: 'xhigh',
  });

  assert.equal(result.provider.name, 'codex');
  assert.equal(getFlagValue(result.invocation.args, '-c'), 'model_reasoning_effort=xhigh');
});

test('runNestedBrowserTask uses the configured provider invocation', async () => {
  const configPath = path.join(tempDir, 'config-codex-runtime.md');
  await fs.promises.writeFile(configPath, [
    '# Evogent Config',
    '',
    '## Brain Provider',
    'Codex CLI',
    '',
  ].join('\n'), 'utf8');

  let seenCommand = '';
  __testOnly.setTestOverrides({
    checkCodexBrowserPrerequisites: async () => {},
    runInvocation: async ({ invocation }) => {
      seenCommand = invocation.command;
      return '{"ok":true}';
    },
  });

  const result = await runNestedBrowserTask({
    prompt: 'Return a JSON object.',
    configPath,
  });

  assert.equal(result, '{"ok":true}');
  assert.equal(seenCommand, 'codex');
});

test('runNestedBrowserTaskDetailed defaults to an isolated data-dir scratch cwd for Codex', async () => {
  const configPath = path.join(tempDir, 'config-codex-cwd.md');
  await fs.promises.writeFile(configPath, [
    '# Evogent Config',
    '',
    '## Brain Provider',
    'Codex CLI',
    '',
  ].join('\n'), 'utf8');

  const previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tempDir;

  let seenCwd = '';
  try {
    __testOnly.setTestOverrides({
      checkCodexBrowserPrerequisites: async () => {},
      runInvocation: async ({ cwd }) => {
        seenCwd = cwd;
        return '{"ok":true}';
      },
    });

    await runNestedBrowserTaskDetailed({
      prompt: 'Return a JSON object.',
      configPath,
    });
  } finally {
    if (previousDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = previousDataDir;
    }
  }

  assert.equal(seenCwd, path.join(tempDir, 'tmp', 'nested-browser-task'));
  assert.ok(fs.existsSync(seenCwd));
});

test('runNestedBrowserTaskDetailed defaults to the repo cwd for Claude', async () => {
  const configPath = path.join(tempDir, 'config-claude-cwd.md');
  await fs.promises.writeFile(configPath, [
    '# Evogent Config',
    '',
    '## Brain Provider',
    'Claude Code',
    '',
  ].join('\n'), 'utf8');

  let seenCwd = '';
  __testOnly.setTestOverrides({
    runInvocation: async ({ cwd }) => {
      seenCwd = cwd;
      return '{"ok":true}';
    },
  });

  await runNestedBrowserTaskDetailed({
    prompt: 'Return a JSON object.',
    configPath,
  });

  assert.equal(seenCwd, process.cwd());
});

test('runNestedBrowserTaskDetailed fails before dispatch when Codex browser prerequisites are missing', async () => {
  const configPath = path.join(tempDir, 'config-codex-prereq.md');
  await fs.promises.writeFile(configPath, [
    '# Evogent Config',
    '',
    '## Brain Provider',
    'Codex CLI',
    '',
  ].join('\n'), 'utf8');

  __testOnly.setTestOverrides({
    checkCodexBrowserPrerequisites: async () => {
      throw new Error('Codex browser prerequisites missing: configure an enabled Playwright MCP server for Codex that targets http://127.0.0.1:9222.');
    },
  });

  await assert.rejects(
    runNestedBrowserTaskDetailed({
      prompt: 'Return a JSON object.',
      configPath,
    }),
    (error: unknown) => {
      assert.ok(error instanceof NestedBrowserTaskExecutionError);
      assert.match(String((error as Error).message), /Playwright MCP server/i);
      return true;
    },
  );
});

test('runNestedBrowserTaskDetailed force-kills a timed-out child that ignores SIGTERM', async () => {
  __testOnly.setTestOverrides({
    buildResult: () => ({
      provider: {
        name: 'codex',
        displayName: 'Codex',
        binaryName: 'bash',
        buildInvocation: () => {
          throw new Error('unused');
        },
        collectAssistantText: () => [],
        formatTranscriptLines: () => [],
        extractFinalResultText: () => null,
      },
      invocation: {
        command: 'bash',
        args: ['-lc', 'trap "" TERM; sleep 30'],
      },
      systemPrompt: 'test',
    }),
  });

  const startedAt = Date.now();
  await assert.rejects(
    runNestedBrowserTaskDetailed({
      prompt: 'hang',
      timeoutMs: 100,
    }),
    (error: unknown) => {
      assert.ok(error instanceof NestedBrowserTaskExecutionError);
      assert.match(String((error as Error).message), /timed out/i);
      assert.equal(error.diagnostics?.timedOut, true);
      assert.ok(typeof error.diagnostics?.pid === 'number' || error.diagnostics?.pid === null);
      return true;
    },
  );
  const elapsedMs = Date.now() - startedAt;

  assert.ok(elapsedMs < 10_000, `Expected forced timeout cleanup, elapsed=${elapsedMs}ms`);
});

test('runNestedBrowserTaskDetailed rejects when a timed-out child exits cleanly during shutdown', async () => {
  __testOnly.setTestOverrides({
    buildResult: () => ({
      provider: {
        name: 'codex',
        displayName: 'Codex',
        binaryName: 'bash',
        buildInvocation: () => {
          throw new Error('unused');
        },
        collectAssistantText: () => [],
        formatTranscriptLines: () => [],
        extractFinalResultText: () => null,
      },
      invocation: {
        command: 'bash',
        args: ['-lc', 'trap "exit 0" TERM; sleep 30'],
      },
      systemPrompt: 'test',
    }),
  });

  await assert.rejects(
    runNestedBrowserTaskDetailed({
      prompt: 'hang',
      timeoutMs: 100,
    }),
    (error: unknown) => {
      assert.ok(error instanceof NestedBrowserTaskExecutionError);
      assert.equal(error.diagnostics?.timedOut, true);
      assert.match(String(error.message), /timed out/i);
      return true;
    },
  );
});

test('runNestedBrowserTaskDetailed assembles split Codex JSON output without newline corruption', async () => {
  __testOnly.setTestOverrides({
    buildResult: () => ({
      provider: createCodexTestProvider(),
      invocation: {
        command: 'node',
        args: ['-e', [
          'const emit = (text) => console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }));',
          'emit(\'{"ok":true,"items":[{"title":"hel\');',
          'emit(\'lo"}]}\');',
        ].join(' ')],
      },
      systemPrompt: 'test',
    }),
    checkCodexBrowserPrerequisites: async () => {},
  });

  const result = await runNestedBrowserTaskDetailed({
    prompt: 'Return a JSON object.',
  });

  assert.equal(result.outputText, '{"ok":true,"items":[{"title":"hello"}]}');
  assert.equal(result.diagnostics.outputTextSource, 'final_result');
  assert.equal(result.diagnostics.producedValidJsonOutput, true);
});

test('runNestedBrowserTaskDetailed extracts the last valid Codex JSON object from concatenated output', async () => {
  __testOnly.setTestOverrides({
    buildResult: () => ({
      provider: createCodexTestProvider(),
      invocation: {
        command: 'node',
        args: ['-e', [
          'const emit = (text) => console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }));',
          'emit(\'{"ok":true}\');',
          'emit(\'{"ok":true,"items":[]}\');',
        ].join(' ')],
      },
      systemPrompt: 'test',
    }),
    checkCodexBrowserPrerequisites: async () => {},
  });

  const result = await runNestedBrowserTaskDetailed({
    prompt: 'Return a JSON object.',
  });

  assert.equal(result.outputText, '{"ok":true,"items":[]}');
  assert.equal(result.diagnostics.outputTextSource, 'last_valid_object');
});

test('runNestedBrowserTaskDetailed extracts the last valid JSON object when assistant text includes prose', async () => {
  __testOnly.setTestOverrides({
    buildResult: () => ({
      provider: createClaudeTestProvider(),
      invocation: {
        command: 'node',
        args: ['-e', [
          'console.log(JSON.stringify({ delta: { text: "Here is the result you asked for:\\n{\\"ok\\":false}" } }));',
          'console.log(JSON.stringify({ delta: { text: "Final answer only:\\n{\\"ok\\":true,\\"items\\":[{\\"title\\":\\"hello\\"}]}" } }));',
        ].join(' ')],
      },
      systemPrompt: 'test',
    }),
  });

  const result = await runNestedBrowserTaskDetailed({
    prompt: 'Return a JSON object.',
  });

  assert.equal(result.outputText, '{"title":"hello"}');
  assert.equal(result.diagnostics.outputTextSource, 'last_valid_object');
  assert.equal(result.diagnostics.producedValidJsonOutput, true);
});

test('runNestedBrowserTaskDetailed assembles split Claude JSON output without inserting newlines', async () => {
  __testOnly.setTestOverrides({
    buildResult: () => ({
      provider: createClaudeTestProvider(),
      invocation: {
        command: 'node',
        args: ['-e', [
          'const emit = (text) => console.log(JSON.stringify({ delta: { text } }));',
          'emit(\'{"ok":true,"items":[{"title":"hel\');',
          'emit(\'lo"}]}\');',
        ].join(' ')],
      },
      systemPrompt: 'test',
    }),
  });

  const result = await runNestedBrowserTaskDetailed({
    prompt: 'Return a JSON object.',
  });

  assert.equal(result.outputText, '{"ok":true,"items":[{"title":"hello"}]}');
  assert.equal(result.diagnostics.outputTextSource, 'assistant_text');
  assert.equal(result.diagnostics.producedValidJsonOutput, true);
});

test('runNestedBrowserTaskDetailed records browser-tool diagnostics from transcript events', async () => {
  __testOnly.setTestOverrides({
    buildResult: () => ({
      provider: {
        name: 'claude' as const,
        displayName: 'Claude',
        binaryName: 'node',
        buildInvocation: () => {
          throw new Error('unused');
        },
        collectAssistantText: (rawEvent: unknown) => {
          const result = (rawEvent as { result?: unknown })?.result;
          return typeof result === 'string' ? [result] : [];
        },
        formatTranscriptLines: () => [],
        extractFinalResultText: (rawEvent: unknown) => {
          const result = (rawEvent as { result?: unknown })?.result;
          return typeof result === 'string' ? result : null;
        },
      },
      invocation: {
        command: 'node',
        args: ['-e', [
          'console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__playwright__browser_navigate", input: { url: "https://example.com" } }] } }));',
          'console.log(JSON.stringify({ type: "result", result: "{\\"ok\\":true}" }));',
        ].join(' ')],
      },
      systemPrompt: 'test',
    }),
  });

  const result = await runNestedBrowserTaskDetailed({
    prompt: 'Return a JSON object.',
  });

  assert.equal(result.diagnostics.sawBrowserToolCall, true);
  assert.equal(result.diagnostics.sawBrowserNavigate, true);
  assert.equal(result.diagnostics.lastBrowserTool, 'mcp__playwright__browser_navigate');
});
