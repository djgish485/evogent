#!/usr/bin/env node

const { spawn } = require('node:child_process');
const { resolveSharedBrowserCdpUrl } = require('../lib/shared-browser-config');

const cdpUrl = resolveSharedBrowserCdpUrl();
const child = spawn('npx', ['@playwright/mcp@latest', '--cdp-endpoint', cdpUrl], {
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});

child.on('error', (error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to launch Playwright MCP against ${cdpUrl}: ${message}`);
  process.exit(1);
});
