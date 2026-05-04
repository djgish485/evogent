import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { getDataPath } from '@/lib/data-dir';
import { resolveBrainProvider } from '../../lib/brain-provider.js';
import { checkCodexBrowserPrerequisites } from '../../lib/codex-browser-prerequisites.js';

const DEFAULT_NESTED_BROWSER_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const NESTED_BROWSER_TASK_KILL_GRACE_MS = 5_000;
const DEFAULT_NESTED_BROWSER_CWD_SEGMENT = 'tmp/nested-browser-task';
const DEFAULT_BROWSER_ALLOWED_TOOLS = 'Browser,Bash,WebFetch,mcp__playwright__browser_navigate,mcp__playwright__browser_snapshot,mcp__playwright__browser_tabs,mcp__playwright__browser_click,mcp__playwright__browser_type,mcp__playwright__browser_fill_form,mcp__playwright__browser_evaluate,mcp__playwright__browser_press_key,mcp__playwright__browser_select_option,mcp__playwright__browser_hover,mcp__playwright__browser_wait_for';
const DEFAULT_BROWSER_BUDGET_PROMPT = 'Treat any requested item limit or count as the primary browsing budget. Once the prompt is satisfied, stop instead of chasing exhaustive coverage.';
const CACHE_BROWSER_BUDGET_PROMPT = 'Extract ALL qualifying items visible on each page. Cache refresh tasks prioritize volume — persist every item that passes the filtering rules rather than stopping at the first batch.';
const DEFAULT_BROWSER_SYSTEM_PROMPT_PREFIX = [
  'You are a short-lived Evogent nested browser task.',
  'Use the configured browser tooling against the existing authenticated shared desktop Chrome session.',
  'Treat that shared browser session as the only browser-auth source of truth.',
  'Do not inspect local project files, task docs, or repo context unless the prompt explicitly asks for that; this invocation is only for browser work.',
  'Start by navigating to the requested page and inspect the rendered result directly before deciding what to do next.',
  'Use browser snapshots selectively when they materially help you understand the current page state or diagnose a blocker.',
];
const DEFAULT_BROWSER_SYSTEM_PROMPT_SUFFIX = [
  'If the page is blocked, logged out, rate-limited, challenged, consent-gated, or otherwise unusable, stop quickly and follow the prompt-specific failure contract instead of continuing to probe.',
  'When a requested field is not readily visible from the rendered page, prefer null, an empty string, or an empty array over extra exploratory browsing.',
  'Follow the prompt-specific persistence and output contract exactly. Some tasks require raw JSON text; others require direct SQLite writes plus a terse final status line.',
  'Do not write files, inspect unrelated local context, or improvise extra output beyond what the prompt asks for.',
];

function buildDefaultBrowserSystemPrompt(isCacheBrowsingTask: boolean) {
  return [
    ...DEFAULT_BROWSER_SYSTEM_PROMPT_PREFIX,
    isCacheBrowsingTask ? CACHE_BROWSER_BUDGET_PROMPT : DEFAULT_BROWSER_BUDGET_PROMPT,
    ...DEFAULT_BROWSER_SYSTEM_PROMPT_SUFFIX,
  ].join(' ');
}

type BrainProviderName = 'claude' | 'codex';
type NestedBrowserTaskReasoningEffort = 'low' | 'medium' | 'high';

interface ProviderInvocation {
  command: string;
  args: string[];
  env?: Record<string, string | undefined>;
}

interface ResolvedProvider {
  name: BrainProviderName;
  displayName: string;
  binaryName: string;
  buildInvocation: (input: {
    prompt: string;
    systemPrompt: string;
    task: {
      priority: string;
      metadata: Record<string, unknown>;
    };
    sessionMode: {
      mode: 'ephemeral';
    };
  }) => ProviderInvocation;
  collectAssistantText: (rawEvent: unknown) => string[];
  formatTranscriptLines: (rawEvent: unknown) => string[];
  extractFinalResultText: (rawEvent: unknown) => string | null;
}

interface BuildNestedBrowserTaskInvocationInput {
  prompt: string;
  systemPrompt?: string;
  configPath?: string;
  isCacheBrowsingTask?: boolean;
  reasoningEffort?: NestedBrowserTaskReasoningEffort | string;
}

export interface RunNestedBrowserTaskInput extends BuildNestedBrowserTaskInvocationInput {
  cwd?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface NestedBrowserTaskExecutionResult {
  outputText: string;
  transcriptLines: string[];
  diagnostics: NestedBrowserTaskDiagnostics;
}

export interface NestedBrowserTaskDiagnostics {
  provider: BrainProviderName;
  command: string;
  cwd: string;
  pid: number | null;
  startedAt: string;
  completedAt: string | null;
  timedOut: boolean;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  stdoutLineCount: number;
  stderrLineCount: number;
  structuredEventCount: number;
  assistantTextChunkCount: number;
  finalResultChunkCount: number;
  malformedJsonLineCount: number;
  sawBrowserToolCall: boolean;
  sawBrowserNavigate: boolean;
  lastBrowserTool: string | null;
  outputTextSource: 'final_result' | 'assistant_text' | 'last_valid_object' | 'longest_valid_part' | 'transcript_fallback' | 'empty';
  producedValidJsonOutput: boolean;
}

export class NestedBrowserTaskExecutionError extends Error {
  transcriptLines: string[];
  diagnostics: NestedBrowserTaskDiagnostics | null;

  constructor(message: string, options: {
    transcriptLines?: string[];
    diagnostics?: NestedBrowserTaskDiagnostics | null;
  } = {}) {
    super(message);
    this.name = 'NestedBrowserTaskExecutionError';
    this.transcriptLines = Array.isArray(options.transcriptLines)
      ? [...options.transcriptLines]
      : [];
    this.diagnostics = options.diagnostics ?? null;
  }
}

interface NestedBrowserTaskBuildResult {
  provider: ResolvedProvider;
  invocation: ProviderInvocation;
  systemPrompt: string;
}

type NestedBrowserTaskTestOverrides = {
  buildResult?: (input: BuildNestedBrowserTaskInvocationInput) => NestedBrowserTaskBuildResult;
  checkCodexBrowserPrerequisites?: (input: { cwd: string }) => Promise<void>;
  runInvocation?: (input: {
    provider: ResolvedProvider;
    invocation: ProviderInvocation;
    cwd: string;
    timeoutMs: number;
  }) => Promise<string>;
};

let testOverrides: NestedBrowserTaskTestOverrides | null = null;

function isUuid(value: unknown) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.trim());
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncateText(value: string, maxLength = 620) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}...`;
}

function safeParseJsonLine(line: string) {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function looksLikeJsonLine(line: string) {
  const trimmed = line.trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

function updateBrowserUsageDiagnostics(input: {
  diagnostics: NestedBrowserTaskDiagnostics;
  text: string;
}) {
  const toolMatch = input.text.match(/\b(mcp__playwright__browser_[a-z_]+|Browser)\b/);
  if (!toolMatch) {
    return;
  }

  input.diagnostics.sawBrowserToolCall = true;
  input.diagnostics.lastBrowserTool = toolMatch[1] || input.diagnostics.lastBrowserTool;
  if (/mcp__playwright__browser_navigate\b/i.test(input.text)) {
    input.diagnostics.sawBrowserNavigate = true;
  }
}

function extractSessionIdFromStreamEvent(rawEvent: unknown) {
  if (!rawEvent || typeof rawEvent !== 'object') {
    return null;
  }

  const record = rawEvent as Record<string, unknown>;
  const direct = typeof record.session_id === 'string'
    ? record.session_id.trim()
    : typeof record.sessionId === 'string'
      ? record.sessionId.trim()
      : '';
  if (isUuid(direct)) {
    return direct;
  }

  const session = record.session;
  if (!session || typeof session !== 'object' || Array.isArray(session)) {
    return null;
  }

  const sessionRecord = session as Record<string, unknown>;
  const nested = typeof sessionRecord.id === 'string'
    ? sessionRecord.id.trim()
    : '';
  return isUuid(nested) ? nested : null;
}

function collectAssistantText(rawEvent: unknown) {
  if (!rawEvent || typeof rawEvent !== 'object') {
    return [];
  }

  const record = rawEvent as Record<string, unknown>;
  if (record.type === 'stream_event') {
    const streamEvent = record.event;
    if (!streamEvent || typeof streamEvent !== 'object' || Array.isArray(streamEvent)) {
      return [];
    }

    const streamRecord = streamEvent as Record<string, unknown>;
    if (streamRecord.type === 'content_block_start') {
      const contentBlock = streamRecord.content_block;
      if (!contentBlock || typeof contentBlock !== 'object' || Array.isArray(contentBlock)) {
        return [];
      }

      const contentBlockRecord = contentBlock as Record<string, unknown>;
      const text = contentBlockRecord.type === 'text' && typeof contentBlockRecord.text === 'string'
        ? contentBlockRecord.text
        : '';
      return text ? [text] : [];
    }

    if (streamRecord.type === 'content_block_delta') {
      const delta = streamRecord.delta;
      if (!delta || typeof delta !== 'object' || Array.isArray(delta)) {
        return [];
      }

      const deltaRecord = delta as Record<string, unknown>;
      const text = deltaRecord.type === 'text_delta' && typeof deltaRecord.text === 'string'
        ? deltaRecord.text
        : '';
      return text ? [text] : [];
    }

    return [];
  }

  if (record.type !== 'assistant') {
    return [];
  }

  const message = record.message;
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return [];
  }

  const content: unknown[] = Array.isArray((message as Record<string, unknown>).content)
    ? (message as Record<string, unknown>).content as unknown[]
    : [];

  return content
    .map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return '';
      }

      const entryRecord = entry as Record<string, unknown>;
      return entryRecord.type === 'text' && typeof entryRecord.text === 'string'
        ? entryRecord.text.trim()
        : '';
    })
    .filter((value): value is string => Boolean(value));
}

function formatTranscriptLines(rawEvent: unknown) {
  if (!rawEvent || typeof rawEvent !== 'object') {
    return [];
  }

  const record = rawEvent as Record<string, unknown>;
  if (record.type === 'assistant') {
    const lines = collectAssistantText(rawEvent).map((text) => truncateText(text));
    const message = record.message;
    const messageRecord = message && typeof message === 'object' && !Array.isArray(message)
      ? message as Record<string, unknown>
      : null;
    const content: unknown[] = messageRecord && Array.isArray(messageRecord.content)
      ? messageRecord.content as unknown[]
      : [];

    for (const entry of content) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        continue;
      }

      const entryRecord = entry as Record<string, unknown>;
      if (entryRecord.type !== 'tool_use') {
        continue;
      }

      const toolName = typeof entryRecord.name === 'string' && entryRecord.name.trim()
        ? entryRecord.name.trim()
        : 'tool';
      const toolInput = entryRecord.input && typeof entryRecord.input === 'object'
        ? truncateText(stringifyUnknown(entryRecord.input), 420)
        : '';
      lines.push(toolInput ? `tool ${toolName}: ${toolInput}` : `tool ${toolName}`);
    }

    return lines;
  }

  if (record.type === 'result') {
    const resultText = truncateText(stringifyUnknown(record.result));
    return [resultText ? `completed: ${resultText}` : 'completed'];
  }

  return [];
}

function extractFinalResultText(rawEvent: unknown) {
  if (!rawEvent || typeof rawEvent !== 'object') {
    return '';
  }

  const record = rawEvent as Record<string, unknown>;
  if (record.type === 'result') {
    return stringifyUnknown(record.result);
  }

  return '';
}

function resolveProvider(configPath: string): ResolvedProvider {
  return resolveBrainProvider({
    DEFAULT_CLAUDE_ALLOWED_TOOLS: DEFAULT_BROWSER_ALLOWED_TOOLS,
    DEFAULT_CLAUDE_CURATION_ALLOWED_TOOLS: DEFAULT_BROWSER_ALLOWED_TOOLS,
    DEFAULT_CLAUDE_PERMISSION_MODE: 'dontAsk',
    collectAssistantText,
    extractChatProgressFromEvent: () => null,
    extractFinalResultText,
    extractSessionIdFromStreamEvent,
    extractStreamingChatTextFromEvent: () => null,
    formatTranscriptLines,
    isCurationTask: () => false,
    isFreshAssistantStreamingSignal: () => false,
    summarizeStreamingChatEvent: () => null,
  }, configPath) as unknown as ResolvedProvider;
}

function trimTranscriptLines(lines: string[], nextLine: string) {
  if (!nextLine) {
    return;
  }

  lines.push(nextLine);
  if (lines.length > 60) {
    lines.splice(0, lines.length - 60);
  }
}

function isValidJsonText(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }

  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function isJsonObjectText(value: string) {
  const trimmed = value.trim();
  if (!trimmed || !trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return false;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return Boolean(parsed) && typeof parsed === 'object' && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function selectLastValidJsonObjectText(parts: string[]) {
  let lastMatch = '';

  for (const part of parts) {
    const text = part.trim();
    if (!text.includes('{')) {
      continue;
    }

    for (let start = 0; start < text.length; start += 1) {
      if (text[start] !== '{') {
        continue;
      }

      let depth = 0;
      let inString = false;
      let escaped = false;

      for (let index = start; index < text.length; index += 1) {
        const char = text[index];

        if (escaped) {
          escaped = false;
          continue;
        }

        if (char === '\\') {
          escaped = true;
          continue;
        }

        if (char === '"') {
          inString = !inString;
          continue;
        }

        if (inString) {
          continue;
        }

        if (char === '{') {
          depth += 1;
          continue;
        }

        if (char !== '}') {
          continue;
        }

        depth -= 1;
        if (depth !== 0) {
          continue;
        }

        const candidate = text.slice(start, index + 1).trim();
        if (isJsonObjectText(candidate)) {
          lastMatch = candidate;
        }
        break;
      }
    }
  }

  return lastMatch;
}

function selectLongestValidJsonText(parts: string[]) {
  let bestMatch = '';

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed || !isValidJsonText(trimmed)) {
      continue;
    }

    if (trimmed.length > bestMatch.length) {
      bestMatch = trimmed;
    }
  }

  return bestMatch;
}

function assembleOutputText(input: {
  finalResultTextParts: string[];
  assistantTextParts: string[];
  transcriptLines: string[];
}) {
  const joinedFinalText = input.finalResultTextParts.join('').trim();
  if (isValidJsonText(joinedFinalText)) {
    return {
      outputText: joinedFinalText,
      outputTextSource: 'final_result' as const,
      producedValidJsonOutput: true,
    };
  }

  const joinedAssistantText = input.assistantTextParts.join('').trim();
  if (isValidJsonText(joinedAssistantText)) {
    return {
      outputText: joinedAssistantText,
      outputTextSource: 'assistant_text' as const,
      producedValidJsonOutput: true,
    };
  }

  const lastValidObject = selectLastValidJsonObjectText([
    joinedFinalText,
    joinedAssistantText,
    ...input.finalResultTextParts,
    ...input.assistantTextParts,
  ]);
  if (lastValidObject) {
    return {
      outputText: lastValidObject,
      outputTextSource: 'last_valid_object' as const,
      producedValidJsonOutput: true,
    };
  }

  const longestValidPart = selectLongestValidJsonText([
    ...input.finalResultTextParts,
    ...input.assistantTextParts,
  ]);
  if (longestValidPart) {
    return {
      outputText: longestValidPart,
      outputTextSource: 'longest_valid_part' as const,
      producedValidJsonOutput: true,
    };
  }

  if (joinedFinalText) {
    return {
      outputText: joinedFinalText,
      outputTextSource: 'final_result' as const,
      producedValidJsonOutput: false,
    };
  }

  if (joinedAssistantText) {
    return {
      outputText: joinedAssistantText,
      outputTextSource: 'assistant_text' as const,
      producedValidJsonOutput: false,
    };
  }

  const transcriptFallback = input.transcriptLines.slice(-30).join('\n').trim();
  if (transcriptFallback) {
    return {
      outputText: transcriptFallback,
      outputTextSource: 'transcript_fallback' as const,
      producedValidJsonOutput: false,
    };
  }

  return {
    outputText: '',
    outputTextSource: 'empty' as const,
    producedValidJsonOutput: false,
  };
}

export function summarizeNestedBrowserTaskDiagnostics(diagnostics: NestedBrowserTaskDiagnostics | null | undefined) {
  if (!diagnostics) {
    return 'no nested browser diagnostics captured';
  }

  return [
    `provider=${diagnostics.provider}`,
    diagnostics.pid ? `pid=${diagnostics.pid}` : null,
    `structuredEvents=${diagnostics.structuredEventCount}`,
    `stdoutLines=${diagnostics.stdoutLineCount}`,
    `stderrLines=${diagnostics.stderrLineCount}`,
    `assistantTextChunks=${diagnostics.assistantTextChunkCount}`,
    `finalResultChunks=${diagnostics.finalResultChunkCount}`,
    `browserTool=${diagnostics.sawBrowserToolCall ? (diagnostics.lastBrowserTool || 'seen') : 'not_seen'}`,
    `browserNavigate=${diagnostics.sawBrowserNavigate ? 'seen' : 'not_seen'}`,
    `malformedJsonLines=${diagnostics.malformedJsonLineCount}`,
    `outputSource=${diagnostics.outputTextSource}`,
    `validJsonOutput=${diagnostics.producedValidJsonOutput ? 'yes' : 'no'}`,
    diagnostics.timedOut ? 'timedOut=yes' : null,
  ].filter(Boolean).join(', ');
}

function buildNestedBrowserTaskInvocation(input: BuildNestedBrowserTaskInvocationInput): NestedBrowserTaskBuildResult {
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if (!prompt) {
    throw new Error('Nested browser task prompt must be a non-empty string');
  }

  if (testOverrides?.buildResult) {
    return testOverrides.buildResult(input);
  }

  const configPath = typeof input.configPath === 'string' && input.configPath.trim()
    ? input.configPath.trim()
    : getDataPath('config.md');
  const provider = resolveProvider(configPath);
  const isCacheBrowsingTask = input.isCacheBrowsingTask === true;
  const systemPrompt = typeof input.systemPrompt === 'string' && input.systemPrompt.trim()
    ? input.systemPrompt.trim()
    : buildDefaultBrowserSystemPrompt(isCacheBrowsingTask);
  const requestedReasoningEffort = typeof input.reasoningEffort === 'string' && input.reasoningEffort.trim()
    ? input.reasoningEffort.trim()
    : null;
  const codexReasoningEffort = requestedReasoningEffort ?? (isCacheBrowsingTask ? null : 'low');

  return {
    provider,
    invocation: provider.buildInvocation({
      prompt,
      systemPrompt,
      task: {
        priority: isCacheBrowsingTask ? 'cache_refresh' : 'post_enrichment',
        metadata: {
          requiresBrowserTools: true,
          ...(provider.name === 'codex' && codexReasoningEffort ? { codexReasoningEffort } : {}),
        },
      },
      sessionMode: {
        mode: 'ephemeral',
      },
    }),
    systemPrompt,
  };
}

function resolveNestedBrowserTaskCwd(providerName: BrainProviderName, cwd: string | undefined) {
  if (typeof cwd === 'string' && cwd.trim()) {
    return cwd.trim();
  }

  if (providerName === 'claude') {
    return process.cwd();
  }

  return getDataPath(DEFAULT_NESTED_BROWSER_CWD_SEGMENT);
}

async function executeInvocation(input: {
  provider: ResolvedProvider;
  invocation: ProviderInvocation;
  cwd: string;
  signal?: AbortSignal;
  timeoutMs: number;
}) {
  return new Promise<NestedBrowserTaskExecutionResult>((resolve, reject) => {
    const startedAt = new Date().toISOString();
    const child: ChildProcess = spawn(input.invocation.command, input.invocation.args, {
      cwd: input.cwd,
      env: {
        ...process.env,
        ...(input.invocation.env ?? {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const transcriptLines: string[] = [];
    const assistantTextParts: string[] = [];
    const finalResultTextParts: string[] = [];
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let timedOut = false;
    let aborted = false;
    let abortError: Error | null = null;
    let killTimer: NodeJS.Timeout | null = null;
    const diagnostics: NestedBrowserTaskDiagnostics = {
      provider: input.provider.name,
      command: input.invocation.command,
      cwd: input.cwd,
      pid: child.pid ?? null,
      startedAt,
      completedAt: null,
      timedOut: false,
      exitCode: null,
      exitSignal: null,
      stdoutLineCount: 0,
      stderrLineCount: 0,
      structuredEventCount: 0,
      assistantTextChunkCount: 0,
      finalResultChunkCount: 0,
      malformedJsonLineCount: 0,
      sawBrowserToolCall: false,
      sawBrowserNavigate: false,
      lastBrowserTool: null,
      outputTextSource: 'empty',
      producedValidJsonOutput: false,
    };

    const clearTimers = () => {
      clearTimeout(timer);
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      input.signal?.removeEventListener('abort', handleAbort);
    };

    const handleAbort = () => {
      if (aborted) {
        return;
      }

      aborted = true;
      abortError = input.signal?.reason instanceof Error
        ? input.signal.reason
        : new Error('Nested browser task aborted');
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, NESTED_BROWSER_TASK_KILL_GRACE_MS);
      killTimer.unref?.();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, NESTED_BROWSER_TASK_KILL_GRACE_MS);
    }, input.timeoutMs);
    timer.unref?.();

    if (input.signal) {
      if (input.signal.aborted) {
        handleAbort();
      } else {
        input.signal.addEventListener('abort', handleAbort, { once: true });
      }
    }

    const handleLine = (line: string, streamName: 'stdout' | 'stderr') => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }

      if (streamName === 'stderr') {
        diagnostics.stderrLineCount += 1;
      } else {
        diagnostics.stdoutLineCount += 1;
      }

      const parsedEvent = safeParseJsonLine(trimmed);
      if (parsedEvent) {
        diagnostics.structuredEventCount += 1;
        updateBrowserUsageDiagnostics({
          diagnostics,
          text: stringifyUnknown(parsedEvent),
        });

        for (const text of input.provider.collectAssistantText(parsedEvent)) {
          if (text) {
            assistantTextParts.push(text);
            diagnostics.assistantTextChunkCount += 1;
          }
        }

        for (const transcriptPart of input.provider.formatTranscriptLines(parsedEvent)) {
          trimTranscriptLines(transcriptLines, transcriptPart);
        }

        const finalText = input.provider.extractFinalResultText(parsedEvent);
        if (finalText) {
          finalResultTextParts.push(finalText);
          diagnostics.finalResultChunkCount += 1;
        }
        return;
      }

      if (looksLikeJsonLine(trimmed)) {
        diagnostics.malformedJsonLineCount += 1;
      }
      updateBrowserUsageDiagnostics({
        diagnostics,
        text: trimmed,
      });

      trimTranscriptLines(transcriptLines, streamName === 'stderr' ? `[stderr] ${trimmed}` : trimmed);
    };

    const consumeChunk = (chunk: string | Buffer, streamName: 'stdout' | 'stderr') => {
      const rawChunk = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      if (streamName === 'stderr') {
        stderrBuffer += rawChunk;
        const lines = stderrBuffer.split(/\r?\n/);
        stderrBuffer = lines.pop() || '';
        for (const line of lines) {
          handleLine(line, 'stderr');
        }
        return;
      }

      stdoutBuffer += rawChunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        handleLine(line, 'stdout');
      }
    };

    child.stdout?.on('data', (chunk) => {
      consumeChunk(chunk, 'stdout');
    });
    child.stderr?.on('data', (chunk) => {
      consumeChunk(chunk, 'stderr');
    });

    child.once('error', (error) => {
      clearTimers();
      reject(error);
    });

    child.once('close', (code, signal) => {
      clearTimers();
      diagnostics.completedAt = new Date().toISOString();
      diagnostics.timedOut = timedOut;
      diagnostics.exitCode = typeof code === 'number' ? code : null;
      diagnostics.exitSignal = signal || null;

      if (stdoutBuffer.trim()) {
        handleLine(stdoutBuffer, 'stdout');
      }
      if (stderrBuffer.trim()) {
        handleLine(stderrBuffer, 'stderr');
      }

      if (timedOut) {
        reject(new NestedBrowserTaskExecutionError(
          `${input.provider.displayName} nested browser task failed (timed out after ${Math.round(input.timeoutMs / 1000)}s). ${summarizeNestedBrowserTaskDiagnostics(diagnostics)}.${transcriptLines.length > 0 ? ` Output: ${transcriptLines.slice(-12).join(' | ').trim()}` : ''}`,
          {
            transcriptLines,
            diagnostics,
          },
        ));
        return;
      }

      if (aborted) {
        reject(new NestedBrowserTaskExecutionError(
          abortError?.message || `${input.provider.displayName} nested browser task aborted`,
          {
            transcriptLines,
            diagnostics,
          },
        ));
        return;
      }

      if (typeof code === 'number' && code === 0) {
        const transcriptFallback = transcriptLines.slice(-30).join('\n').trim();
        const assembledOutput = assembleOutputText({
          finalResultTextParts,
          assistantTextParts,
          transcriptLines,
        });
        diagnostics.outputTextSource = assembledOutput.outputTextSource;
        diagnostics.producedValidJsonOutput = assembledOutput.producedValidJsonOutput;
        resolve({
          outputText: assembledOutput.outputText || transcriptFallback,
          transcriptLines: [...transcriptLines],
          diagnostics: {
            ...diagnostics,
          },
        });
        return;
      }

      const outputTail = transcriptLines.slice(-12).join(' | ').trim();
      const failureDetail = timedOut
        ? `timed out after ${Math.round(input.timeoutMs / 1000)}s`
        : signal || code || 'unknown';
      reject(new NestedBrowserTaskExecutionError(
        `${input.provider.displayName} nested browser task failed (${failureDetail}). ${summarizeNestedBrowserTaskDiagnostics(diagnostics)}.${outputTail ? ` Output: ${outputTail}` : ''}`,
        {
          transcriptLines,
          diagnostics,
        },
      ));
    });
  });
}

async function ensureProviderBrowserPrerequisites(input: {
  provider: ResolvedProvider;
  cwd: string;
}) {
  if (input.provider.name !== 'codex') {
    return;
  }

  try {
    if (testOverrides?.checkCodexBrowserPrerequisites) {
      await testOverrides.checkCodexBrowserPrerequisites({ cwd: input.cwd });
      return;
    }

    const result = await checkCodexBrowserPrerequisites({
      cwd: input.cwd,
      env: process.env,
    });
    if (!result.ok) {
      throw new Error(result.message || 'Codex browser prerequisites missing.');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new NestedBrowserTaskExecutionError(message, {
      transcriptLines: [],
    });
  }
}

export async function runNestedBrowserTaskDetailed(input: RunNestedBrowserTaskInput) {
  const buildResult = buildNestedBrowserTaskInvocation(input);
  const cwd = resolveNestedBrowserTaskCwd(buildResult.provider.name, input.cwd);
  const timeoutMs = Number.isFinite(input.timeoutMs)
    ? Math.max(1, Math.floor(input.timeoutMs as number))
    : DEFAULT_NESTED_BROWSER_TIMEOUT_MS;

  await fs.promises.mkdir(cwd, { recursive: true });

  await ensureProviderBrowserPrerequisites({
    provider: buildResult.provider,
    cwd,
  });

  if (testOverrides?.runInvocation) {
    const outputText = await testOverrides.runInvocation({
      provider: buildResult.provider,
      invocation: buildResult.invocation,
      cwd,
      timeoutMs,
    });
    return {
      outputText,
      transcriptLines: [],
      diagnostics: {
        provider: buildResult.provider.name,
        command: buildResult.invocation.command,
        cwd,
        pid: null,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        timedOut: false,
        exitCode: 0,
        exitSignal: null,
        stdoutLineCount: 0,
        stderrLineCount: 0,
        structuredEventCount: 0,
        assistantTextChunkCount: 0,
        finalResultChunkCount: 0,
        malformedJsonLineCount: 0,
        sawBrowserToolCall: false,
        sawBrowserNavigate: false,
        lastBrowserTool: null,
        outputTextSource: 'assistant_text',
        producedValidJsonOutput: isValidJsonText(outputText),
      },
    } satisfies NestedBrowserTaskExecutionResult;
  }

  return executeInvocation({
    provider: buildResult.provider,
    invocation: buildResult.invocation,
    cwd,
    signal: input.signal,
    timeoutMs,
  });
}

export async function runNestedBrowserTask(input: RunNestedBrowserTaskInput) {
  const result = await runNestedBrowserTaskDetailed(input);
  return result.outputText;
}

export const __testOnly = {
  buildNestedBrowserTaskInvocation,
  resolveNestedBrowserTaskCwd,
  setTestOverrides(overrides: NestedBrowserTaskTestOverrides | null) {
    testOverrides = overrides;
  },
  resetTestOverrides() {
    testOverrides = null;
  },
};
