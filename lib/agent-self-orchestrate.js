'use strict';

/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * agent-self-orchestrate.js — Spawn a dev agent that runs its OWN validation,
 * merge, and reporting. Replaces the agent-runner.js + validate.sh + reconciliation
 * stack with a single prompt the agent reads and obeys.
 *
 * Inputs: { taskId, suggestion, options }
 * Side effects:
 *   - Creates a git worktree when the target repo supports it
 *   - Copies .env.local into the worktree when one is created
 *   - Runs the detected install command when one is available
 *   - Launches a systemd unit (or tmux fallback) running `claude -p <prompt>` (or codex equivalent)
 *   - Returns immediately. The agent itself reports progress to /api/internal/code-fix/report.
 */

const { execSync, execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {
  DEFAULT_GIT_OPS_LOCK_TIMEOUT_MS,
  execGitCommandWithLock,
} = require('./git-ops-lock');
const { getGitCredentialEnv, getGitCredentialEnvForLaunch } = require('./git-credential-env');
const {
  readBrainConfig,
  DEFAULT_CLAUDE_REASONING_EFFORT,
  DEFAULT_CODE_FIX_REASONING_EFFORT,
  resolveCodeFixReasoningEffortForProvider,
} = require('./brain-config');
const { readDevAgentRepoConfig } = require('./repo-agent-config');
const { buildAgentPrompt } = require('./dev-agent-prompt');

const DEFAULT_LOCK_TIMEOUT_MS = DEFAULT_GIT_OPS_LOCK_TIMEOUT_MS;

const DEFAULT_ALLOWED_TOOLS = 'Bash,Edit,Read,Write,Glob,Grep,WebFetch,WebSearch,LSP,NotebookEdit';
const DEFAULT_CLAUDE_MODEL = 'claude-opus-4-7[1m]';
const DEFAULT_CODEX_MODEL = 'gpt-5.5';

function findExecutable(command) {
  const searchPath = process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  for (const dir of searchPath.split(':')) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // continue
    }
  }
  return null;
}

function isLinuxSystemdAvailable() {
  return process.platform === 'linux'
    && fs.existsSync('/run/systemd/system')
    && Boolean(findExecutable('systemd-run'))
    && Boolean(findExecutable('systemctl'));
}

function sanitizeUnitName(value) {
  return String(value || '')
    .replace(/[^a-zA-Z0-9_.:-]+/g, '-')
    .slice(0, 180);
}

function getUnitName(taskId) {
  return `evogent-dev-agent-${sanitizeUnitName(taskId)}.service`;
}

const DEV_AGENT_UNIT_PATTERN = 'evogent-dev-agent-*.service';

function getMaxConcurrentDevAgents() {
  const raw = process.env.MEDIA_AGENT_MAX_DEV_AGENTS;
  const parsed = parseInt(raw || '', 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return 4;
}

function countActiveDevAgentUnits() {
  if (!isLinuxSystemdAvailable()) return 0;
  const result = spawnSync('systemctl', [
    'list-units',
    DEV_AGENT_UNIT_PATTERN,
    '--state=active',
    '--no-legend',
    '--plain',
    '--no-pager',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 });
  if (result.status !== 0) return 0;
  const lines = String(result.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line.startsWith('evogent-dev-agent-'));
  return lines.length;
}

function stopDevAgentUnit(taskId, options = {}) {
  const unit = getUnitName(taskId);
  const spawnSyncImpl = typeof options.spawnSync === 'function' ? options.spawnSync : spawnSync;
  const timeout = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 15_000;

  if (process.platform !== 'linux' || !findExecutable('systemctl')) {
    return { ok: false, skipped: true, unit, error: 'systemctl is not available' };
  }

  const result = spawnSyncImpl('sudo', ['-n', 'systemctl', 'stop', unit], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
  });
  const stdout = String(result.stdout || '').trim();
  const stderr = String(result.stderr || '').trim();
  const output = [stdout, stderr].filter(Boolean).join('\n');

  if (result.error) {
    return { ok: false, unit, error: result.error.message };
  }

  if (result.status === 0) {
    return { ok: true, unit };
  }

  if (/not loaded|not found|could not be found|does not exist|no such file/i.test(output)) {
    return { ok: true, unit, notFound: true };
  }

  return {
    ok: false,
    unit,
    status: result.status,
    error: output || `sudo systemctl stop exited with status ${result.status}`,
  };
}

function resolveAgentProvider(repoDir) {
  try {
    const brain = readBrainConfig(path.join(repoDir, 'data', 'config.md'));
    if (brain && (brain.provider === 'claude' || brain.provider === 'codex')) {
      return { provider: brain.provider, brain };
    }
  } catch {
    // fall through
  }
  return { provider: 'codex', brain: { provider: 'codex' } };
}

function runShell(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    stdio: 'pipe',
    encoding: 'utf8',
    ...opts,
  });
}

function runInstallCommand({ taskId, installCommand, cwd }) {
  if (!installCommand) return;
  try {
    execSync(installCommand, {
      cwd,
      stdio: 'pipe',
      timeout: 800_000,
      shell: '/bin/bash',
    });
  } catch (err) {
    console.warn(`[agent-self-orchestrate] install warning for ${taskId}:`, err?.message);
  }
}

function prepareWorkspace({ taskId, repoDir, worktreeDir, useWorktree, baseRef, installCommand }) {
  if (!useWorktree) {
    runInstallCommand({ taskId, installCommand, cwd: repoDir });
    return;
  }

  fs.mkdirSync(path.dirname(worktreeDir), { recursive: true });
  if (fs.existsSync(worktreeDir)) {
    // idempotent: if a previous attempt left a worktree, remove it (safe — branch will be recreated)
    try {
      execGitCommandWithLock(['worktree', 'remove', '--force', worktreeDir], {
        cwd: repoDir,
        stdio: 'pipe',
        lockTimeoutMs: DEFAULT_LOCK_TIMEOUT_MS,
      });
    } catch {
      // fall through; rm -rf is the last resort
    }
    if (fs.existsSync(worktreeDir)) {
      fs.rmSync(worktreeDir, { recursive: true, force: true });
    }
  }
  // Also remove any pre-existing branch with the same name (from a failed previous run)
  try {
    execGitCommandWithLock(['branch', '-D', taskId], {
      cwd: repoDir,
      stdio: 'pipe',
      lockTimeoutMs: DEFAULT_LOCK_TIMEOUT_MS,
    });
  } catch {
    // non-fatal — branch may not exist
  }

  if (baseRef && baseRef.startsWith('origin/')) {
    execGitCommandWithLock(['fetch', 'origin', baseRef.slice('origin/'.length)], {
      cwd: repoDir,
      stdio: 'pipe',
      lockTimeoutMs: DEFAULT_LOCK_TIMEOUT_MS,
    });
  }
  execGitCommandWithLock(['worktree', 'add', worktreeDir, '-b', taskId, baseRef || 'HEAD'], {
    cwd: repoDir,
    stdio: 'pipe',
    lockTimeoutMs: DEFAULT_LOCK_TIMEOUT_MS,
  });

  const envLocal = path.join(repoDir, '.env.local');
  if (fs.existsSync(envLocal)) {
    fs.copyFileSync(envLocal, path.join(worktreeDir, '.env.local'));
  }

  runInstallCommand({ taskId, installCommand, cwd: worktreeDir });
}

function buildClaudeArgs({ prompt, brainConfig }) {
  const codeFixEffort = brainConfig && brainConfig.codeFixReasoningEffort;
  const effort = resolveCodeFixReasoningEffortForProvider(
    codeFixEffort || DEFAULT_CODE_FIX_REASONING_EFFORT,
    'claude',
  ) || DEFAULT_CLAUDE_REASONING_EFFORT;
  const model = process.env.CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL;
  return [
    '--model', model,
    '--allowedTools', DEFAULT_ALLOWED_TOOLS,
    '--effort', effort,
    '-p', prompt,
  ];
}

function buildCodexArgs({ prompt, brainConfig }) {
  const model = process.env.CODEX_MODEL || (brainConfig && brainConfig.codexModel) || DEFAULT_CODEX_MODEL;
  const codeFixEffort = brainConfig && brainConfig.codeFixReasoningEffort;
  const resolvedCodeFixEffort = resolveCodeFixReasoningEffortForProvider(
    codeFixEffort || DEFAULT_CODE_FIX_REASONING_EFFORT,
    'codex',
  );
  const effort = process.env.CODEX_REASONING || resolvedCodeFixEffort || 'high';
  const args = [
    'exec',
    '--model', model,
    '-c', `model_reasoning_effort=${effort}`,
  ];
  if (process.env.CODEX_FAST_MODE === '1' || process.env.CODEX_FAST_MODE === 'true') {
    args.push('-c', 'service_tier="fast"');
  }
  args.push('-s', 'danger-full-access', prompt);
  return args;
}

function launchCommandProcess({ taskId, exe, args, worktreeDir, env }) {
  if (isLinuxSystemdAvailable()) {
    const unit = getUnitName(taskId);
    const systemdArgs = [
      '--unit', unit,
      '--property', 'Restart=no',
      '--property', 'KillMode=process',
      '--property', `WorkingDirectory=${worktreeDir}`,
      '--property', 'TimeoutStopSec=30',
      '--property', 'RuntimeMaxSec=3900',
      '--collect',
    ];
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined || value === null) continue;
      systemdArgs.push('--setenv', `${key}=${String(value)}`);
    }
    systemdArgs.push(exe, ...args);
    const result = spawnSync('systemd-run', systemdArgs, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
    });
    if (result.status === 0) {
      return { mode: 'systemd', unit };
    }
    console.warn(`[agent-self-orchestrate] systemd-run failed for ${taskId}: ${result.stderr || result.error?.message}; falling back to tmux`);
  }

  const session = `agent-${sanitizeUnitName(taskId)}`;
  const envPrefix = Object.entries(env)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `export ${key}='${String(value).replace(/'/g, "'\\''")}'`)
    .join('; ');
  const escapedCommand = [exe, ...args]
    .map((arg) => `'${String(arg).replace(/'/g, "'\\''")}'`)
    .join(' ');
  const tmuxCommand = `${envPrefix}; ${escapedCommand}`;
  runShell('tmux', ['new-session', '-d', '-s', session, '-c', worktreeDir, tmuxCommand], { timeout: 10_000 });
  return { mode: 'tmux', tmuxSession: session };
}

function launchAgentProcess({ taskId, provider, claudeArgs, codexArgs, worktreeDir, env }) {
  return launchCommandProcess({
    taskId,
    exe: provider === 'claude' ? 'claude' : 'codex',
    args: provider === 'claude' ? claudeArgs : codexArgs,
    worktreeDir,
    env,
  });
}

function launchCustomPipelineProcess({ taskId, pipelinePath, worktreeDir, env }) {
  return launchCommandProcess({
    taskId,
    exe: 'bash',
    args: [pipelinePath],
    worktreeDir,
    env,
  });
}

/**
 * Spawn a self-orchestrating dev agent.
 *
 * @param {object} params
 * @param {string} params.taskId
 * @param {object} params.suggestion - { id, suggestionId, feedItemId, title, text, proposedValue, originSessionId }
 * @param {object} [params.options]
 * @param {string} [params.options.repoDir]
 * @param {string} [params.options.internalBaseUrl]
 */
function spawnSelfOrchestratingDevAgent({ taskId, suggestion, options = {} }) {
  if (!taskId || typeof taskId !== 'string') {
    throw new Error('taskId is required');
  }
  if (!suggestion || typeof suggestion !== 'object') {
    throw new Error('suggestion is required');
  }
  const proposedValue = suggestion.proposedValue || suggestion.text || '';
  if (!proposedValue.trim()) {
    throw new Error('suggestion.proposedValue is required');
  }

  const repoDir = options.repoDir || process.cwd();
  const internalBaseUrl = options.internalBaseUrl
    || process.env.MEDIA_AGENT_INTERNAL_BASE_URL
    || `http://127.0.0.1:${process.env.PORT || '3001'}`;
  let repoConfig;
  try {
    repoConfig = readDevAgentRepoConfig(repoDir);
  } catch (error) {
    console.error(`[agent-self-orchestrate] Failed to load dev-agent addon for ${repoDir}:`, error?.message || error);
    throw error;
  }

  const worktreeBase = options.worktreeBase || `${repoDir}-worktrees`;
  const worktreeDir = repoConfig.useWorktree ? path.join(worktreeBase, taskId) : repoDir;
  const branchName = taskId;

  // Spawn-depth guard
  const spawnDepth = parseInt(process.env.MEDIA_AGENT_SPAWN_DEPTH || '0', 10);
  if (spawnDepth > 0) {
    throw new Error(`Recursive spawn blocked: MEDIA_AGENT_SPAWN_DEPTH=${spawnDepth}`);
  }

  const cap = getMaxConcurrentDevAgents();
  const activeCount = countActiveDevAgentUnits();
  if (activeCount >= cap) {
    throw new Error(`Max concurrent agents (${cap}) reached. Active: ${activeCount}`);
  }

  const { provider, brain } = resolveAgentProvider(repoDir);

  prepareWorkspace({
    taskId,
    repoDir,
    worktreeDir,
    useWorktree: repoConfig.useWorktree,
    baseRef: repoConfig.baseRef,
    installCommand: repoConfig.installCommand,
  });

  const prompt = buildAgentPrompt({
    taskId,
    branchName,
    worktreePath: worktreeDir,
    repoDir,
    internalBaseUrl,
    suggestion,
    repoConfig,
  });

  // Persist the prompt for debugging/audit
  const promptFile = path.join(worktreeDir, '.agent-prompt.txt');
  try {
    fs.writeFileSync(promptFile, prompt);
  } catch {
    // non-fatal
  }

  const claudeArgs = buildClaudeArgs({ prompt, brainConfig: brain });
  const codexArgs = buildCodexArgs({ prompt, brainConfig: brain });

  const credentialEnv = getGitCredentialEnv(process.env);
  const homeBin = credentialEnv.HOME ? `${credentialEnv.HOME}/.local/bin` : '/root/.local/bin';
  const launchEnv = getGitCredentialEnvForLaunch(process.env, {
    MEDIA_AGENT_SPAWN_DEPTH: '1',
    PATH: `${homeBin}:${process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'}`,
    MEDIA_AGENT_INTERNAL_BASE_URL: internalBaseUrl,
    HOME: credentialEnv.HOME || process.env.HOME || '/root',
    TASK_ID: taskId,
    PROMPT_FILE: promptFile,
    MERGE_TARGET: repoConfig.mergeTarget || 'main',
  });
  if (repoConfig.useWorktree) {
    launchEnv.WORKTREE_PATH = worktreeDir;
  }

  const launch = repoConfig.customPipeline
    ? launchCustomPipelineProcess({
        taskId,
        pipelinePath: path.resolve(worktreeDir, repoConfig.customPipeline),
        worktreeDir,
        env: launchEnv,
      })
    : launchAgentProcess({
        taskId,
        provider,
        claudeArgs,
        codexArgs,
        worktreeDir,
        env: launchEnv,
      });

  console.log(`[agent-self-orchestrate] Spawned ${taskId} (${repoConfig.customPipeline ? 'custom-pipeline' : provider}) in ${worktreeDir}; launch=${launch.mode}`);

  return {
    taskId,
    provider,
    worktree: repoConfig.useWorktree ? worktreeDir : null,
    workingDirectory: worktreeDir,
    branch: repoConfig.useWorktree ? branchName : null,
    launch,
  };
}

module.exports = {
  buildAgentPrompt,
  spawnSelfOrchestratingDevAgent,
  countActiveDevAgentUnits,
  getMaxConcurrentDevAgents,
  stopDevAgentUnit,
};
