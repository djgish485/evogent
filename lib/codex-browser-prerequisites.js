const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const {
  compactString,
  normalizeSharedBrowserLoopbackUrl,
  resolveSharedBrowserCdpUrl,
} = require('./shared-browser-config');

const execFileAsync = promisify(execFile);
const DEFAULT_CODEX_PREREQ_TIMEOUT_MS = 8_000;
const PLAYWRIGHT_MCP_LAUNCHER_PATH = path.join('scripts', 'start-playwright-mcp.js');

function normalizeServerName(value) {
  return compactString(value).toLowerCase();
}

function compactErrorMessage(error) {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }

  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }

  return 'unknown error';
}

function looksLikePlaywrightTransport(transport) {
  if (!transport || typeof transport !== 'object' || Array.isArray(transport)) {
    return false;
  }

  const command = compactString(transport.command).toLowerCase();
  const args = Array.isArray(transport.args)
    ? transport.args.map((value) => compactString(value).toLowerCase()).filter(Boolean)
    : [];

  if (command.includes('playwright')) {
    return true;
  }

  return args.some((arg) => arg.includes('@playwright/mcp') || arg.includes('playwright'));
}

function looksLikeManagedPlaywrightLauncher(transport, cwd = process.cwd()) {
  if (!transport || typeof transport !== 'object' || Array.isArray(transport)) {
    return false;
  }

  const args = Array.isArray(transport.args) ? transport.args : [];
  return args.some((arg) => {
    const trimmed = compactString(arg);
    if (!trimmed) {
      return false;
    }

    if (trimmed === PLAYWRIGHT_MCP_LAUNCHER_PATH || trimmed.endsWith(`/${PLAYWRIGHT_MCP_LAUNCHER_PATH}`)) {
      return true;
    }

    try {
      return path.resolve(cwd, trimmed) === path.resolve(cwd, PLAYWRIGHT_MCP_LAUNCHER_PATH);
    } catch {
      return false;
    }
  });
}

function findConfiguredPlaywrightServer(servers) {
  if (!Array.isArray(servers)) {
    return null;
  }

  const namedServer = servers.find((server) => normalizeServerName(server?.name) === 'playwright');
  if (namedServer) {
    return namedServer;
  }

  return servers.find((server) => looksLikePlaywrightTransport(server?.transport)) || null;
}

function extractConfiguredCdpUrl(server, options = {}) {
  const transport = server?.transport;
  if (!transport || typeof transport !== 'object' || Array.isArray(transport)) {
    return null;
  }

  if (looksLikeManagedPlaywrightLauncher(transport, options.cwd)) {
    return resolveSharedBrowserCdpUrl({
      configuredUrl: options.expectedCdpUrl,
      env: options.env,
    });
  }

  const args = Array.isArray(transport.args) ? transport.args : [];
  const endpointFlagIndex = args.findIndex((arg) => compactString(arg) === '--cdp-endpoint');
  if (endpointFlagIndex >= 0 && endpointFlagIndex < args.length - 1) {
    return normalizeSharedBrowserLoopbackUrl(args[endpointFlagIndex + 1]);
  }

  return null;
}

async function listCodexMcpServers(options = {}) {
  const execImpl = options.execFileImpl || execFileAsync;
  const result = await execImpl('codex', ['mcp', 'list', '--json'], {
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
    timeout: DEFAULT_CODEX_PREREQ_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 1024 * 256,
  });

  const payload = compactString(`${result.stdout || ''}`);
  if (!payload) {
    throw new Error('codex mcp list --json returned empty output');
  }

  const parsed = JSON.parse(payload);
  if (!Array.isArray(parsed)) {
    throw new Error('codex mcp list --json returned a non-array payload');
  }

  return parsed;
}

async function checkCodexBrowserPrerequisites(options = {}) {
  const cwd = options.cwd || process.cwd();
  const env = options.env || process.env;
  const checkedAt = new Date().toISOString();
  const expectedCdpUrl = resolveSharedBrowserCdpUrl({
    configuredUrl: options.expectedCdpUrl,
    env,
  });

  let servers;
  try {
    servers = await listCodexMcpServers({
      cwd,
      env,
      execFileImpl: options.execFileImpl,
    });
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error
      ? String(error.code || '')
      : '';
    const detail = compactErrorMessage(error);
    return {
      ok: false,
      checkedAt,
      expectedCdpUrl,
      configuredCdpUrl: null,
      serverName: null,
      reason: code === 'ENOENT' ? 'codex_missing' : 'codex_mcp_unavailable',
      message: code === 'ENOENT'
        ? 'Codex browser prerequisites missing: codex is not available on this machine.'
        : `Codex browser prerequisites missing: unable to inspect Codex MCP servers (${detail}).`,
    };
  }

  const server = findConfiguredPlaywrightServer(servers);
  if (!server) {
    return {
      ok: false,
      checkedAt,
      expectedCdpUrl,
      configuredCdpUrl: null,
      serverName: null,
      reason: 'playwright_missing',
      message: `Codex browser prerequisites missing: configure an enabled Playwright MCP server for Codex that targets ${expectedCdpUrl}.`,
    };
  }

  if (server.enabled === false) {
    const disabledReason = compactString(server.disabled_reason);
    return {
      ok: false,
      checkedAt,
      expectedCdpUrl,
      configuredCdpUrl: null,
      serverName: compactString(server.name) || 'playwright',
      reason: 'playwright_disabled',
      message: disabledReason
        ? `Codex browser prerequisites missing: Playwright MCP server "${compactString(server.name) || 'playwright'}" is disabled (${disabledReason}).`
        : `Codex browser prerequisites missing: Playwright MCP server "${compactString(server.name) || 'playwright'}" is disabled.`,
    };
  }

  const configuredCdpUrl = extractConfiguredCdpUrl(server, {
    cwd,
    env,
    expectedCdpUrl,
  });
  if (!configuredCdpUrl) {
    return {
      ok: false,
      checkedAt,
      expectedCdpUrl,
      configuredCdpUrl: null,
      serverName: compactString(server.name) || 'playwright',
      reason: 'playwright_endpoint_missing',
      message: `Codex browser prerequisites missing: Playwright MCP server "${compactString(server.name) || 'playwright'}" does not expose a shared Chrome CDP endpoint. Expected ${expectedCdpUrl}.`,
    };
  }

  if (configuredCdpUrl !== expectedCdpUrl) {
    return {
      ok: false,
      checkedAt,
      expectedCdpUrl,
      configuredCdpUrl,
      serverName: compactString(server.name) || 'playwright',
      reason: 'playwright_endpoint_mismatch',
      message: `Codex browser prerequisites missing: Playwright MCP server "${compactString(server.name) || 'playwright'}" targets ${configuredCdpUrl}, but Evogent uses ${expectedCdpUrl} as the shared Chrome CDP endpoint.`,
    };
  }

  return {
    ok: true,
    checkedAt,
    expectedCdpUrl,
    configuredCdpUrl,
    serverName: compactString(server.name) || 'playwright',
    reason: 'ok',
    message: null,
  };
}

module.exports = {
  checkCodexBrowserPrerequisites,
  listCodexMcpServers,
  __testOnly: {
    extractConfiguredCdpUrl,
    findConfiguredPlaywrightServer,
    looksLikeManagedPlaywrightLauncher,
    looksLikePlaywrightTransport,
    PLAYWRIGHT_MCP_LAUNCHER_PATH,
  },
};
