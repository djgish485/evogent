#!/usr/bin/env tsx
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getDb } from '../src/lib/db/client';
import { getDataDir } from '../src/lib/data-dir';
import { getFirstRunReadiness, type FirstRunReadiness } from '../src/lib/setup-readiness';
import {
  DEFAULT_CURATOR_AGENT_SESSION_TITLE,
  DEFAULT_GENERAL_AGENT_SESSION_TITLE,
} from '../src/lib/chat-session-title';

const require = createRequire(import.meta.url);
const { checkCodexBrowserPrerequisites } = require('../lib/codex-browser-prerequisites.js') as {
  checkCodexBrowserPrerequisites: (options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  }) => Promise<{
    ok: boolean;
    expectedCdpUrl: string;
    serverName: string | null;
    message: string | null;
    reason?: string;
  }>;
};
const {
  getGitCredentialEnv,
} = require('../lib/git-credential-env.js') as {
  getGitCredentialEnv: (env?: Record<string, string | undefined>) => Record<string, string>;
};

interface BasicCheck {
  key: string;
  status: 'READY' | 'PENDING' | 'REQUIRED';
  message: string;
}

type BrowserProvider = 'claude' | 'codex';

const DEFAULT_SHARED_BROWSER_CDP_URL = 'http://127.0.0.1:9222';
const BROWSER_BACKED_SETUP_SOURCES = new Set(['twitter', 'youtube', 'substack']);
const CLAUDE_BROWSER_TOOL_ALLOWLIST = [
  'Browser',
  'mcp__playwright__browser_navigate',
  'mcp__playwright__browser_snapshot',
  'mcp__playwright__browser_tabs',
  'mcp__playwright__browser_click',
  'mcp__playwright__browser_type',
  'mcp__playwright__browser_fill_form',
  'mcp__playwright__browser_evaluate',
  'mcp__playwright__browser_press_key',
  'mcp__playwright__browser_select_option',
  'mcp__playwright__browser_hover',
  'mcp__playwright__browser_wait_for',
];

function fileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function parseRedisTarget(): { host: string; port: number } {
  const redisUrl = process.env.MEDIA_AGENT_REDIS_URL || process.env.REDIS_URL || 'redis://127.0.0.1:6379';
  try {
    const parsed = new URL(redisUrl);
    return {
      host: parsed.hostname || '127.0.0.1',
      port: Number.parseInt(parsed.port || '6379', 10),
    };
  } catch {
    return { host: '127.0.0.1', port: 6379 };
  }
}

async function checkRedis(timeoutMs = 600): Promise<BasicCheck> {
  const target = parseRedisTarget();
  return new Promise((resolve) => {
    const socket = net.createConnection(target);
    let settled = false;

    const finish = (status: BasicCheck['status'], message: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ key: 'redis', status, message });
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish('READY', `Redis reachable at ${target.host}:${target.port}`));
    socket.once('timeout', () => finish('PENDING', `Redis not reachable at ${target.host}:${target.port}; start Redis before running background jobs.`));
    socket.once('error', () => finish('PENDING', `Redis not reachable at ${target.host}:${target.port}; start Redis before running background jobs.`));
  });
}

function getPlatformCheck(): BasicCheck {
  if (process.platform === 'linux') {
    return {
      key: 'service_adapter',
      status: 'READY',
      message: 'Linux detected. Use sudo bash scripts/setup.sh for the systemd service adapter after shared readiness is clean.',
    };
  }
  if (process.platform === 'darwin') {
    return {
      key: 'service_adapter',
      status: 'PENDING',
      message: 'macOS detected. Run npm start and node worker.js in separate terminals, or create a LaunchAgent after readiness is clean.',
    };
  }
  if (process.platform === 'win32') {
    return {
      key: 'service_adapter',
      status: 'PENDING',
      message: 'Windows detected. Run npm start and node worker.js in separate terminals; scripts/setup.sh is Linux/systemd-only.',
    };
  }
  return {
    key: 'service_adapter',
    status: 'PENDING',
    message: `${process.platform} detected. Use the local npm start plus node worker.js path.`,
  };
}

function sanitizeGitAuthFailure(stderr: string, status: number | null): string {
  if (/could not read Username/i.test(stderr)) {
    return 'git could not read GitHub credentials noninteractively.';
  }
  if (/Authentication failed/i.test(stderr)) {
    return 'git credential authentication failed noninteractively.';
  }
  if (/Repository not found/i.test(stderr)) {
    return 'git could not access the configured origin repository.';
  }
  if (/not a git repository/i.test(stderr)) {
    return 'current directory is not a git repository.';
  }
  return `git exited with status ${status ?? 'unknown'}.`;
}

function getGitAuthCheck(rootDir = process.cwd()): BasicCheck {
  const gitEnv = getGitCredentialEnv({});
  const homeBin = gitEnv.HOME ? `${gitEnv.HOME}/.local/bin` : '/root/.local/bin';
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'production',
    PATH: `${homeBin}:${process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'}`,
    ...gitEnv,
  };
  const result = spawnSync('git', ['ls-remote', '--heads', 'origin', 'main'], {
    cwd: rootDir,
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20_000,
  });

  if (result.status === 0) {
    return {
      key: 'git_auth',
      status: 'READY',
      message: `Noninteractive git auth works for origin/main with service runner env HOME=${gitEnv.HOME || '(unset)'}.`,
    };
  }

  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  return {
    key: 'git_auth',
    status: 'REQUIRED',
    message: `${sanitizeGitAuthFailure(stderr, result.status)} Re-run GitHub auth for the service user or rerun scripts/setup.sh after auth is configured. Checked with GIT_TERMINAL_PROMPT=0 HOME=${gitEnv.HOME || '(unset)'}.`,
  };
}

function parseSystemdEnvironment(content: string): Set<string> {
  const keys = new Set<string>();
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    const match = trimmed.match(/^Environment=([A-Za-z_][A-Za-z0-9_]*)=/);
    if (match) {
      keys.add(match[1]);
    }
  }
  return keys;
}

function getSystemdGitEnvCheck(): BasicCheck {
  if (process.platform !== 'linux') {
    return {
      key: 'systemd_git_env',
      status: 'PENDING',
      message: 'Systemd service git credential environment is only required on Linux service installs.',
    };
  }

  const servicePaths = [
    '/etc/systemd/system/evogent.service',
    '/etc/systemd/system/evogent-worker.service',
  ];
  const existingServices = servicePaths.filter((servicePath) => fileExists(servicePath));
  if (existingServices.length === 0) {
    return {
      key: 'systemd_git_env',
      status: 'PENDING',
      message: 'Systemd services are not installed yet. Run sudo bash scripts/setup.sh after shared readiness is clean.',
    };
  }

  const requiredKeys = ['HOME', 'XDG_CONFIG_HOME', 'GH_CONFIG_DIR', 'GIT_TERMINAL_PROMPT'];
  const missing: string[] = [];
  for (const servicePath of existingServices) {
    const keys = parseSystemdEnvironment(fs.readFileSync(servicePath, 'utf8'));
    const missingKeys = requiredKeys.filter((key) => !keys.has(key));
    if (missingKeys.length > 0) {
      missing.push(`${path.basename(servicePath)} missing ${missingKeys.join(',')}`);
    }
  }

  if (missing.length > 0) {
    return {
      key: 'systemd_git_env',
      status: 'REQUIRED',
      message: `${missing.join('; ')}. Re-run sudo bash scripts/setup.sh so app-owned code-fix runners inherit noninteractive git credentials.`,
    };
  }

  return {
    key: 'systemd_git_env',
    status: 'READY',
    message: 'Installed systemd services pass HOME, XDG_CONFIG_HOME, GH_CONFIG_DIR, and GIT_TERMINAL_PROMPT to app-owned git operations.',
  };
}

async function getBasicChecks(): Promise<BasicCheck[]> {
  const dataDir = getDataDir();
  fs.mkdirSync(dataDir, { recursive: true });

  let schemaCheck: BasicCheck;
  try {
    getDb();
    schemaCheck = { key: 'schema', status: 'READY', message: 'SQLite schema initialized.' };
  } catch (error) {
    schemaCheck = {
      key: 'schema',
      status: 'REQUIRED',
      message: `SQLite schema failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  return [
    {
      key: 'node_modules',
      status: fileExists(path.join(process.cwd(), 'node_modules')) ? 'READY' : 'REQUIRED',
      message: fileExists(path.join(process.cwd(), 'node_modules')) ? 'npm dependencies installed.' : 'Run npm install.',
    },
    {
      key: 'build',
      status: fileExists(path.join(process.cwd(), '.next')) ? 'READY' : 'PENDING',
      message: fileExists(path.join(process.cwd(), '.next')) ? 'Next build output exists.' : 'Run npm run build.',
    },
    {
      key: 'env',
      status: fileExists(path.join(process.cwd(), '.env.local')) ? 'READY' : 'PENDING',
      message: fileExists(path.join(process.cwd(), '.env.local')) ? '.env.local exists.' : 'Copy .env.example to .env.local and edit it.',
    },
    {
      key: 'data_dir',
      status: 'READY',
      message: `Data directory ready at ${dataDir}.`,
    },
    getPhase2ConsentCheck(path.join(dataDir, 'config.md')),
    schemaCheck,
    await checkRedis(),
    getAgentStateCheck(),
    getGitAuthCheck(),
    getSystemdGitEnvCheck(),
    getPlatformCheck(),
  ];
}

function extractMarkdownSection(content: string, heading: string): string | null {
  const lines = content.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => new RegExp(`^##\\s+${heading}\\s*$`, 'i').test(line.trim()));
  if (startIndex === -1) return null;
  const sectionLines: string[] = [];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^##\s+/.test(line.trim())) break;
    sectionLines.push(line);
  }
  return sectionLines
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('<!--'))
    .join('\n') || null;
}

function getPhase2ConsentCheck(configPath: string): BasicCheck {
  let content = '';
  try {
    content = fs.readFileSync(configPath, 'utf8');
  } catch {
    return {
      key: 'phase2_choices',
      status: 'REQUIRED',
      message: 'Before writing data/config.md, ask README Phase 2 choices in one compact prompt: Agent Name, Brain Provider, Usage Level, sources to configure now, optional manual interests, and optional archive import.',
    };
  }

  const missing = [
    ['Agent Name', 'agent name'],
    ['Brain Provider', 'brain provider'],
    ['Usage Level', 'usage level'],
  ].flatMap(([heading, label]) => extractMarkdownSection(content, heading) ? [] : [label]);

  if (missing.length > 0) {
    return {
      key: 'phase2_choices',
      status: 'REQUIRED',
      message: `Ask README Phase 2 choices before setup continues; data/config.md is missing ${missing.join(', ')}.`,
    };
  }

  return {
    key: 'phase2_choices',
    status: 'READY',
    message: 'data/config.md records explicit Phase 2 choices for agent name, brain provider, and usage level.',
  };
}

function getAgentStateCheck(): BasicCheck {
  const stateDir = process.env.MEDIA_AGENT_STATE_DIR || path.join(process.cwd(), 'data', 'agent-state');
  if (stateDir === '/root/.clawdbot') {
    return {
      key: 'agent_state_dir',
      status: 'REQUIRED',
      message: 'MEDIA_AGENT_STATE_DIR points at legacy /root/.clawdbot. Move active-tasks.json/logs into data/agent-state or unset MEDIA_AGENT_STATE_DIR.',
    };
  }
  return {
    key: 'agent_state_dir',
    status: 'READY',
    message: `Dev-agent state directory is app-owned at ${stateDir}.`,
  };
}

function normalizeLoopbackUrl(value: string | null | undefined): string {
  const compacted = typeof value === 'string' ? value.trim() : '';
  if (!compacted) return '';

  try {
    const url = new URL(compacted);
    if (url.hostname === 'localhost' || url.hostname === '::1' || url.hostname === '[::1]') {
      url.hostname = '127.0.0.1';
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    return compacted;
  }
}

function resolveExpectedCdpUrl(): string {
  return normalizeLoopbackUrl(
    process.env.MEDIA_AGENT_SHARED_BROWSER_CDP_URL
      || process.env.SHARED_BROWSER_CDP_URL
      || DEFAULT_SHARED_BROWSER_CDP_URL,
  );
}

function parseJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function getPlaywrightServer(config: Record<string, unknown> | null): Record<string, unknown> | null {
  const servers = config?.mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return null;
  const server = (servers as Record<string, unknown>).playwright;
  return server && typeof server === 'object' && !Array.isArray(server)
    ? server as Record<string, unknown>
    : null;
}

function extractClaudeMcpCdpUrl(rootDir: string, server: Record<string, unknown>): string | null {
  const command = typeof server.command === 'string' ? server.command : '';
  const args = Array.isArray(server.args) ? server.args.map((arg) => String(arg)) : [];
  const usesManagedLauncher = command === 'node' && args.some((arg) => {
    const trimmed = arg.trim();
    return trimmed === 'scripts/start-playwright-mcp.js'
      || path.resolve(rootDir, trimmed) === path.resolve(rootDir, 'scripts/start-playwright-mcp.js');
  });
  if (usesManagedLauncher) return resolveExpectedCdpUrl();

  const endpointIndex = args.findIndex((arg) => arg === '--cdp-endpoint');
  return endpointIndex >= 0 && endpointIndex < args.length - 1
    ? normalizeLoopbackUrl(args[endpointIndex + 1])
    : null;
}

function checkClaudeBrowserPrerequisites(rootDir = process.cwd()): BasicCheck {
  const defaultTools = process.env.CLAUDE_ALLOWED_TOOLS || 'Bash,Edit,Read,Write,Glob,Grep,WebFetch,WebSearch';
  const allowedTools = process.env.CLAUDE_CURATION_ALLOWED_TOOLS
    || `${defaultTools},${CLAUDE_BROWSER_TOOL_ALLOWLIST.join(',')}`;
  const toolSet = new Set(allowedTools.split(',').map((tool) => tool.trim()).filter(Boolean));
  const hasPlaywrightTools = toolSet.has('mcp__playwright__*')
    || [...toolSet].some((tool) => tool.startsWith('mcp__playwright__browser_'));
  if (!hasPlaywrightTools) {
    return {
      key: 'browser_provider',
      status: 'PENDING',
      message: 'Claude browser tools are not allowlisted; include mcp__playwright__* or mcp__playwright__browser_* in CLAUDE_CURATION_ALLOWED_TOOLS.',
    };
  }

  const expectedCdpUrl = resolveExpectedCdpUrl();
  for (const configPath of [
    path.join(rootDir, '.mcp.json'),
    path.join(rootDir, '.claude', 'settings.local.json'),
  ]) {
    const server = getPlaywrightServer(parseJsonFile(configPath));
    if (!server) continue;
    const configuredCdpUrl = extractClaudeMcpCdpUrl(rootDir, server);
    if (!configuredCdpUrl) {
      return {
        key: 'browser_provider',
        status: 'PENDING',
        message: `Claude Playwright MCP server in ${path.relative(rootDir, configPath)} does not expose a shared Chrome CDP endpoint. Expected ${expectedCdpUrl}.`,
      };
    }
    if (configuredCdpUrl !== expectedCdpUrl) {
      return {
        key: 'browser_provider',
        status: 'PENDING',
        message: `Claude Playwright MCP server in ${path.relative(rootDir, configPath)} targets ${configuredCdpUrl}, but Evogent uses ${expectedCdpUrl}.`,
      };
    }
    return {
      key: 'browser_provider',
      status: 'READY',
      message: `Claude Playwright MCP server "playwright" targets shared Chrome CDP ${expectedCdpUrl}.`,
    };
  }

  return {
    key: 'browser_provider',
    status: 'PENDING',
    message: `Claude Playwright MCP server "playwright" is not configured. Add .mcp.json with scripts/start-playwright-mcp.js targeting ${expectedCdpUrl}.`,
  };
}

function sourceReadinessRequiresBrowserProvider(readiness: FirstRunReadiness['sources']): boolean {
  return readiness.ready && readiness.items.some((item) => BROWSER_BACKED_SETUP_SOURCES.has(item.source.trim().toLowerCase()));
}

function requireBrowserProviderWhenNeeded(check: BasicCheck, required: boolean): BasicCheck {
  if (!required || check.status !== 'PENDING') {
    return check;
  }
  return { ...check, status: 'REQUIRED' };
}

export function formatCodexBrowserProviderMessage(result: Awaited<ReturnType<typeof checkCodexBrowserPrerequisites>>): string {
  const serverName = result.serverName || 'playwright';
  if (result.ok) {
    return `Codex Playwright MCP server "${serverName}" targets shared Chrome CDP ${result.expectedCdpUrl}.`;
  }

  const baseMessage = result.reason === 'playwright_missing'
    ? `Codex Playwright MCP server "${serverName}" is missing for shared Chrome CDP ${result.expectedCdpUrl}.`
    : result.message || `Codex Playwright MCP server "${serverName}" must target shared Chrome CDP ${result.expectedCdpUrl}.`;
  return `${baseMessage} Codex MCP setup: add server "${serverName}" with node scripts/start-playwright-mcp.js so it targets ${result.expectedCdpUrl}.`;
}

async function getBrowserProviderCheck(
  provider: BrowserProvider | null,
  sourceReadiness: FirstRunReadiness['sources'],
): Promise<BasicCheck> {
  const browserProviderRequired = sourceReadinessRequiresBrowserProvider(sourceReadiness);
  if (!provider) {
    return {
      key: 'browser_provider',
      status: 'PENDING',
      message: 'Waiting for a runnable brain provider before checking shared Chrome browser-tool wiring.',
    };
  }

  if (provider === 'claude') {
    return requireBrowserProviderWhenNeeded(
      checkClaudeBrowserPrerequisites(),
      browserProviderRequired,
    );
  }

  const result = await checkCodexBrowserPrerequisites({
    cwd: process.cwd(),
    env: process.env,
  });
  return requireBrowserProviderWhenNeeded({
    key: 'browser_provider',
    status: result.ok ? 'READY' : 'PENDING',
    message: formatCodexBrowserProviderMessage(result),
  }, browserProviderRequired);
}

export function formatSetupAgentReport(checks: BasicCheck[], readiness: FirstRunReadiness): string {
  const lines = [
    'Evogent setup readiness',
    ...checks.map((check) => `${check.status} ${check.key}: ${check.message}`),
  ];
  const defaultSessionsMessage = readiness.sessions.ready
    ? `${DEFAULT_GENERAL_AGENT_SESSION_TITLE}=${readiness.sessions.mainSessionId} ${DEFAULT_CURATOR_AGENT_SESSION_TITLE}=${readiness.sessions.curatorSessionId}`
    : 'Create with npm run setup:agent -- --bootstrap-default-sessions after provider readiness is clean.';

  lines.push(`${readiness.provider.ready ? 'READY' : 'REQUIRED'} brain_provider: ${readiness.provider.message}`);
  lines.push(`${readiness.sessions.ready ? 'READY' : 'PENDING'} default_sessions: ${defaultSessionsMessage}`);
  lines.push(`${readiness.sources.ready ? 'READY' : 'REQUIRED'} content_source: ${readiness.sources.message}`);

  if (!readiness.sources.ready) {
    lines.push('NEXT phase2: ask the user which source(s) to configure before installing skills or running smoke tests; X/Twitter is recommended, not implied consent.');
    lines.push('NEXT source_path: selected X/Twitter -> /setup-source x.com -> quiet background source browsing -> open shared Chrome CDP profile on 9222 -> wait for user-confirmed login -> verify provider MCP wiring -> install tweet-cache -> run exactly one packaged setup-smoke /cache-refresh twitter');
    lines.push('NEXT source_path: selected YouTube -> /setup-source youtube.com -> quiet background source browsing -> open shared Chrome CDP profile on 9222 -> wait for user-confirmed login -> verify provider MCP wiring -> install youtube-cache -> run exactly one packaged setup-smoke /cache-refresh youtube');
    lines.push('NEXT source_path: selected Substack -> /setup-source substack.com -> quiet background source browsing -> open shared Chrome CDP profile on 9222 -> wait for user-confirmed login -> verify provider MCP wiring -> install substack-cache -> run exactly one packaged setup-smoke /cache-refresh substack');
  }

  return `${lines.join('\n')}\n`;
}

async function main() {
  const bootstrapDefaultSessions = process.argv.includes('--bootstrap-default-sessions')
    || process.env.MEDIA_AGENT_BOOTSTRAP_DEFAULT_SESSIONS === '1';
  const [basicChecks, readiness] = await Promise.all([
    getBasicChecks(),
    getFirstRunReadiness({ bootstrapDefaultSessions }),
  ]);
  const checks = [
    ...basicChecks,
    await getBrowserProviderCheck(readiness.provider.selected, readiness.sources),
  ];
  const report = formatSetupAgentReport(checks, readiness);
  process.stdout.write(report);

  const hasRequired = checks.some((check) => check.status === 'REQUIRED') || readiness.required.length > 0;
  process.exitCode = hasRequired ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
