import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDataPath } from '@/lib/data-dir';
import { readBrainConfig } from '../../lib/brain-config.js';

export type SubAgentType = 'curation' | 'enrichment' | 'research';
export type SubAgentStatus = 'running' | 'completed' | 'failed' | 'killed' | 'timed_out';
export type SubAgentProvider = 'claude' | 'codex';

export interface SpawnSubAgentOptions {
  allowedTools?: string[];
  permissionMode?: string;
  appendSystemPrompt?: string;
  model?: string;
  provider?: SubAgentProvider;
  reasoningEffort?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface SubAgentHandle {
  id: string;
  type: SubAgentType;
  logFile: string;
  process: ChildProcess;
  status: SubAgentStatus;
  startedAt: string;
  provider: SubAgentProvider;
  command: string;
}

const DEFAULT_ALLOWED_TOOLS = 'Bash,Read,Write,WebSearch,WebFetch';
const DEFAULT_PERMISSION_MODE = 'dontAsk';
const AGENT_LOGS_DIR = getDataPath('agent-logs');
const DEFAULT_CODEX_REASONING_EFFORT = 'high';

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function timestampForFilename(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function ensureAgentLogsDir() {
  await fs.promises.mkdir(AGENT_LOGS_DIR, { recursive: true });
}

async function readDefaultBrainContext(type: SubAgentType): Promise<string> {
  const claudePath = path.join(process.cwd(), 'CLAUDE.md');

  try {
    const brainPrompt = await fs.promises.readFile(claudePath, 'utf8');
    return [
      `You are running as a delegated ${type} sub-agent for Evogent.`,
      'Follow the main brain rules below while focusing only on the delegated task.',
      brainPrompt,
    ].join('\n\n');
  } catch {
    return `You are running as a delegated ${type} sub-agent for Evogent.`;
  }
}

function resolveRequestedProvider(options: SpawnSubAgentOptions): {
  provider: SubAgentProvider;
  model: string;
  reasoningEffort: string;
} {
  const brainConfig = readBrainConfig(getDataPath('config.md'));
  const provider: SubAgentProvider = (options.provider ?? brainConfig.provider) === 'codex'
    ? 'codex'
    : 'claude';
  const requestedModel = options.model?.trim() || '';
  const isCodexModel = /^(gpt|o\d|o3|o4|codex)/i.test(requestedModel);

  if (provider === 'codex') {
    return {
      provider,
      model: isCodexModel ? requestedModel : brainConfig.codexModel,
      reasoningEffort: options.reasoningEffort?.trim() || brainConfig.codexReasoningEffort || DEFAULT_CODEX_REASONING_EFFORT,
    };
  }

  return {
    provider,
    model: requestedModel,
    reasoningEffort: '',
  };
}

export async function spawnSubAgent(
  type: SubAgentType,
  prompt: string,
  options: SpawnSubAgentOptions = {},
): Promise<SubAgentHandle> {
  const trimmedPrompt = prompt.trim();
  if (!trimmedPrompt) {
    throw new Error('Sub-agent prompt must be a non-empty string');
  }

  await ensureAgentLogsDir();

  const logFile = path.join(AGENT_LOGS_DIR, `${type}-${timestampForFilename()}.jsonl`);
  await fs.promises.appendFile(logFile, '');

  const id = randomUUID();
  const allowedTools = (options.allowedTools ?? DEFAULT_ALLOWED_TOOLS.split(','))
    .map((tool) => tool.trim())
    .filter(Boolean)
    .join(',');

  const permissionMode = options.permissionMode?.trim() || DEFAULT_PERMISSION_MODE;
  const brainContext = options.appendSystemPrompt ?? await readDefaultBrainContext(type);
  const resolvedProvider = resolveRequestedProvider(options);

  const command = resolvedProvider.provider === 'codex'
    ? [
        'codex',
        'exec',
        '--json',
        `--model ${shellEscape(resolvedProvider.model)}`,
        `-c ${shellEscape(`model_reasoning_effort=${resolvedProvider.reasoningEffort}`)}`,
        '--dangerously-bypass-approvals-and-sandbox',
        shellEscape([
          'Follow the system instructions below for this delegated task.',
          '',
          brainContext,
          '',
          trimmedPrompt,
        ].join('\n')),
        `> ${shellEscape(logFile)} 2>&1`,
      ].join(' ')
    : [
        'claude',
        `-p ${shellEscape(trimmedPrompt)}`,
        ...(resolvedProvider.model ? [`--model ${shellEscape(resolvedProvider.model)}`] : []),
        `--allowedTools ${shellEscape(allowedTools || DEFAULT_ALLOWED_TOOLS)}`,
        `--permission-mode ${shellEscape(permissionMode)}`,
        `--append-system-prompt ${shellEscape(brainContext)}`,
        '--output-format stream-json',
        '--verbose',
        `> ${shellEscape(logFile)} 2>&1`,
      ].join(' ');

  const child = spawn('bash', ['-lc', command], {
    cwd: options.cwd || process.cwd(),
    env: {
      ...process.env,
      ...(options.env ?? {}),
    },
    stdio: 'ignore',
    detached: true,
  });
  child.unref();

  const handle: SubAgentHandle = {
    id,
    type,
    logFile,
    process: child,
    status: 'running',
    startedAt: new Date().toISOString(),
    provider: resolvedProvider.provider,
    command,
  };

  child.once('error', () => {
    handle.status = 'failed';
  });

  child.once('exit', (code, signal) => {
    if (handle.status === 'killed' || handle.status === 'timed_out') {
      return;
    }

    if (signal) {
      handle.status = 'failed';
      return;
    }

    handle.status = code === 0 ? 'completed' : 'failed';
  });

  return handle;
}
