'use strict';

const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { readPromptAddon } = require('./prompt-addons');

const DEFAULT_GATE_ORDER = Object.freeze(['lint', 'build', 'test']);

function hasOwn(record, key) {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function getBoolean(data, key, fallback) {
  if (!hasOwn(data, key)) return fallback;
  if (typeof data[key] === 'boolean') return data[key];
  throw new Error(`.claude/dev-agent-addon.md frontmatter "${key}" must be a boolean`);
}

function getString(data, key, fallback = '') {
  if (!hasOwn(data, key)) return fallback;
  const value = data[key];
  if (typeof value === 'string') return value.trim();
  if (value === null || value === false) return '';
  throw new Error(`.claude/dev-agent-addon.md frontmatter "${key}" must be a string`);
}

function getStringList(data, key) {
  if (!hasOwn(data, key)) return null;
  if (!Array.isArray(data[key])) {
    throw new Error(`.claude/dev-agent-addon.md frontmatter "${key}" must be a list`);
  }
  return data[key].map((value) => {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`.claude/dev-agent-addon.md frontmatter "${key}" must contain only non-empty strings`);
    }
    return value.trim();
  });
}

function isInsideGitWorkTree(repoDir) {
  try {
    const output = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: repoDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    }).trim();
    return output === 'true';
  } catch {
    return false;
  }
}

function gitOutput(repoDir, args) {
  try {
    return execFileSync('git', args, {
      cwd: repoDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    }).trim();
  } catch {
    return '';
  }
}

function detectMergeTarget(repoDir) {
  const remoteHead = gitOutput(repoDir, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (remoteHead.startsWith('origin/')) return remoteHead.slice('origin/'.length);
  const currentBranch = gitOutput(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return currentBranch && currentBranch !== 'HEAD' ? currentBranch : 'main';
}

function resolveBaseRef(repoDir, mergeTarget) {
  const remoteRef = `origin/${mergeTarget}`;
  if (gitOutput(repoDir, ['rev-parse', '--verify', '--quiet', remoteRef])) return remoteRef;
  if (gitOutput(repoDir, ['rev-parse', '--verify', '--quiet', mergeTarget])) return mergeTarget;
  return 'HEAD';
}

function detectInstallCommand(repoDir) {
  if (fs.existsSync(path.join(repoDir, 'package-lock.json'))) return 'npm install';
  if (fs.existsSync(path.join(repoDir, 'yarn.lock'))) return 'yarn install';
  if (fs.existsSync(path.join(repoDir, 'pnpm-lock.yaml'))) return 'pnpm install';
  return '';
}

function readPackageScripts(repoDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(repoDir, 'package.json'), 'utf8'));
    return parsed && typeof parsed.scripts === 'object' && parsed.scripts ? parsed.scripts : {};
  } catch {
    return {};
  }
}

function commandPrefixForInstall(installCommand) {
  if (/^pnpm\b/.test(installCommand)) return 'pnpm';
  if (/^yarn\b/.test(installCommand)) return 'yarn';
  return 'npm run';
}

function gateToCommand(gate, installCommand) {
  if (/\s/.test(gate) || /^(npm|yarn|pnpm|node|npx|tsx)\b/.test(gate)) return gate;
  const prefix = commandPrefixForInstall(installCommand);
  if (prefix === 'npm run' && gate === 'test') return 'npm test';
  return `${prefix} ${gate}`;
}

function detectGateNames(repoDir, data) {
  const configured = getStringList(data, 'gates');
  if (configured) return configured;
  const scripts = readPackageScripts(repoDir);
  return DEFAULT_GATE_ORDER.filter((gate) => typeof scripts[gate] === 'string' && scripts[gate].trim());
}

function detectReceiptAwareMergeScript(repoDir) {
  const scriptPath = path.join(repoDir, 'scripts', 'agents', 'finalize-merge.sh');
  const helperPath = path.join(repoDir, 'scripts', 'agents', 'receipt-helpers.sh');
  if (fs.existsSync(scriptPath) && fs.existsSync(helperPath)) {
    return 'scripts/agents/finalize-merge.sh';
  }
  return '';
}

function buildRepoMergeLockPath(repoDir) {
  const digest = createHash('sha1').update(path.resolve(repoDir)).digest('hex').slice(0, 16);
  return `/tmp/code-fix-merge-${digest}.lock`;
}

function readModeConfig(repoDir) {
  const mediaMode = readPromptAddon(repoDir, '.evogent-mode.md');
  const legacyAddon = readPromptAddon(repoDir, '.claude/dev-agent-addon.md');
  const modeAddon = mediaMode.exists ? mediaMode : legacyAddon;
  const modeData = modeAddon.data || {};
  const legacyData = legacyAddon.data || {};
  const data = mediaMode.exists ? { ...legacyData, ...modeData } : legacyData;
  const addon = legacyAddon.exists ? { ...legacyAddon, data } : { ...modeAddon, data, body: '' };
  const readValue = (key) => {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = String(modeAddon.body || '').match(new RegExp(`^\\s*${escaped}\\s*:\\s*([^#\\r\\n]*)`, 'm'));
    return match ? match[1].trim() : '';
  };
  const modeValue = readValue('mode');
  const mergeAfterValue = readValue('mergeAfterGates');
  const mode = hasOwn(modeData, 'mode') ? getString(modeData, 'mode') : modeValue || getString(legacyData, 'mode');
  let mergeAfterGates = getBoolean(legacyData, 'mergeAfterGates', false);

  if (mergeAfterValue && mergeAfterValue !== 'true' && mergeAfterValue !== 'false') {
    throw new Error(`${modeAddon.path} "mergeAfterGates" must be a boolean`);
  }
  if (mergeAfterValue) mergeAfterGates = mergeAfterValue === 'true';
  if (hasOwn(modeData, 'mergeAfterGates')) mergeAfterGates = getBoolean(modeData, 'mergeAfterGates', false);

  if (mode === 'direct') return { addon, data, mergeAfterGates: false, pushAfterMerge: false };
  if (mode === 'suggestion-local') return { addon, data, mergeAfterGates: true, pushAfterMerge: false };
  if (mode === 'suggestion-remote') return { addon, data, mergeAfterGates, pushAfterMerge: mergeAfterGates };
  if (mode) throw new Error(`${modeAddon.path} mode must be direct, suggestion-local, or suggestion-remote`);

  return {
    addon,
    data,
    mergeAfterGates,
    pushAfterMerge: mergeAfterGates && Boolean(gitOutput(repoDir, ['remote'])),
  };
}

function readDevAgentRepoConfig(repoDir) {
  const modeConfig = readModeConfig(repoDir);
  const { addon, data } = modeConfig;
  const insideGitWorkTree = isInsideGitWorkTree(repoDir);
  const useWorktree = insideGitWorkTree && getBoolean(data, 'useWorktree', true);
  const installCommand = getString(data, 'installCommand', detectInstallCommand(repoDir));
  const validateCommand = getString(data, 'validateCommand');
  const gateNames = validateCommand ? [] : detectGateNames(repoDir, data);
  const validationCommands = validateCommand
    ? [validateCommand]
    : gateNames.map((gate) => gateToCommand(gate, installCommand));
  const mergeTarget = getString(data, 'mergeTarget', insideGitWorkTree ? detectMergeTarget(repoDir) : '');
  const mergeAfterGates = useWorktree && modeConfig.mergeAfterGates;
  const pushAfterMerge = mergeAfterGates && modeConfig.pushAfterMerge;
  const receiptAwareMergeScript = mergeAfterGates
    ? getString(data, 'receiptAwareMergeScript', detectReceiptAwareMergeScript(repoDir))
    : '';

  return {
    addon,
    insideGitWorkTree,
    useWorktree,
    installCommand,
    validationCommands,
    mergeAfterGates,
    pushAfterMerge,
    mergeTarget,
    baseRef: useWorktree ? resolveBaseRef(repoDir, mergeTarget) : '',
    mergeLockPath: mergeAfterGates ? buildRepoMergeLockPath(repoDir) : '',
    receiptAwareMergeScript,
    postMergeHook: getString(data, 'postMergeHook'),
    customPipeline: getString(data, 'customPipeline'),
  };
}

module.exports = {
  buildRepoMergeLockPath,
  readDevAgentRepoConfig,
};
