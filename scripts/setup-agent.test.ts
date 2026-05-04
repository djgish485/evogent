import assert from 'node:assert';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { formatCodexBrowserProviderMessage, formatSetupAgentReport } from './setup-agent';
import type { FirstRunReadiness, ProviderAvailability } from '../src/lib/setup-readiness';
import type { BrainProviderName } from '../src/lib/db/chat-sessions';

function availability(provider: BrainProviderName, available: boolean): ProviderAvailability {
  return {
    provider,
    providerDisplayName: provider === 'codex' ? 'Codex CLI' : 'Claude Code',
    providerBinary: provider,
    available,
    version: available ? `${provider}-test` : null,
    error: available ? null : `${provider} missing`,
  };
}

function writeConfig(dataDir: string): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.md'), [
    '# Evogent Config',
    '',
    '## Agent Name',
    'Evogent',
    '',
    '## Brain Provider',
    'Codex CLI',
    '',
    '## Usage Level',
    'Medium',
    '',
  ].join('\n'), 'utf8');
}

async function runSetupAgentCli(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const tsxBin = path.join(process.cwd(), 'node_modules', '.bin', 'tsx');
  const command = fs.existsSync(tsxBin) ? tsxBin : 'npx';
  const commandArgs = fs.existsSync(tsxBin)
    ? [path.join(process.cwd(), 'scripts', 'setup-agent.ts'), ...args]
    : ['tsx', path.join(process.cwd(), 'scripts', 'setup-agent.ts'), ...args];
  return new Promise((resolve) => {
    execFile(command, commandArgs, {
      cwd: process.cwd(),
      env,
      encoding: 'utf8',
      timeout: 30_000,
    }, (_error, stdout) => resolve(stdout));
  });
}

test('setup agent report prints hard required provider and source lines', () => {
  const readiness: FirstRunReadiness = {
    checkedAt: '2026-04-26T00:00:00.000Z',
    provider: {
      configured: 'claude',
      selected: null,
      ready: false,
      blocked: true,
      message: 'Install Claude Code or Codex CLI, then run this setup check again.',
      providers: {
        claude: availability('claude', false),
        codex: availability('codex', false),
      },
    },
    sessions: {
      ready: false,
      mainSessionId: null,
      curatorSessionId: null,
    },
    sources: {
      ready: false,
      items: [],
      message: 'Configure at least one content source or the feed will be empty.',
      recommendedCommands: [],
    },
    required: [
      'Install Claude Code or Codex CLI, then run this setup check again.',
      'Configure at least one content source or the feed will be empty.',
    ],
    pending: ['Default chat sessions can be created with the explicit bootstrap action after a runnable brain provider is available.'],
    ready: [],
  };

  const report = formatSetupAgentReport([
    { key: 'node_modules', status: 'READY', message: 'npm dependencies installed.' },
  ], readiness);

  assert.match(report, /^READY node_modules: npm dependencies installed\./m);
  assert.match(report, /^REQUIRED brain_provider: Install Claude Code or Codex CLI/m);
  assert.match(report, /^PENDING default_sessions: Create with npm run setup:agent -- --bootstrap-default-sessions/m);
  assert.match(report, /^REQUIRED content_source: Configure at least one content source/m);
  assert.match(report, /^NEXT phase2: ask the user which source\(s\) to configure before installing skills or running smoke tests; X\/Twitter is recommended, not implied consent\./m);
  assert.match(report, /^NEXT source_path: selected X\/Twitter -> \/setup-source x\.com -> quiet background source browsing -> open shared Chrome CDP profile on 9222 -> wait for user-confirmed login -> verify provider MCP wiring -> install tweet-cache -> run exactly one packaged setup-smoke \/cache-refresh twitter/m);

  const codingAgentOnlyReport = formatSetupAgentReport([], readiness, { codingAgentOnly: true });
  assert.match(codingAgentOnlyReport, /^PENDING default_sessions: Create with npm run setup:agent -- --bootstrap-default-sessions --coding-agent-only/m);
});

test('setup agent report names bootstrapped default chat sessions', () => {
  const readiness: FirstRunReadiness = {
    checkedAt: '2026-04-26T00:00:00.000Z',
    provider: {
      configured: 'codex',
      selected: 'codex',
      ready: true,
      blocked: false,
      message: 'Brain provider CLI ready: Codex CLI.',
      providers: {
        claude: availability('claude', false),
        codex: availability('codex', true),
      },
    },
    sessions: {
      ready: true,
      mainSessionId: '00000000-0000-4000-8000-000000000001',
      curatorSessionId: '00000000-0000-4000-8000-000000000002',
    },
    sources: {
      ready: true,
      items: [{
        source: 'twitter',
        label: 'X/Twitter',
        skill: 'tweet-cache',
        evidence: {
          runId: 'setup-source-twitter-setup-source-twitter-test',
          taskId: 'setup-source-twitter-test',
          itemsAdded: 5,
          completedAtMs: 1777248000000,
        },
      }],
      message: 'Content source ready: X/Twitter.',
      recommendedCommands: [],
    },
    required: [],
    pending: [],
    ready: [
      'Brain provider CLI ready: Codex CLI.',
      'Default General Agent and Curator Agent chat sessions exist.',
      'Content source ready: X/Twitter.',
    ],
  };

  const report = formatSetupAgentReport([], readiness);

  assert.match(report, /^READY default_sessions: General Agent=00000000-0000-4000-8000-000000000001 Curator Agent=00000000-0000-4000-8000-000000000002$/m);
});

test('setup agent CLI coding-agent-only bootstrap reports only the General Agent', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-setup-agent-cli-test-'));
  try {
    const dataDir = path.join(tempDir, 'data');
    const dbPath = path.join(dataDir, 'media-agent.db');
    const binDir = path.join(tempDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'codex'), '#!/usr/bin/env sh\necho codex-test\n', { mode: 0o755 });
    fs.writeFileSync(path.join(binDir, 'git'), '#!/usr/bin/env sh\nexit 0\n', { mode: 0o755 });
    writeConfig(dataDir);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DATA_DIR: dataDir,
      MEDIA_AGENT_DB_PATH: dbPath,
      MEDIA_AGENT_REDIS_URL: 'redis://127.0.0.1:1',
      MEDIA_AGENT_SKILLS_DIR: path.join(tempDir, 'skills'),
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    };
    delete env.TEST_SERVER_DATA_DIR;

    const report = await runSetupAgentCli(['--bootstrap-default-sessions', '--coding-agent-only'], env);
    const defaultSessionsLine = report
      .split('\n')
      .find((line) => line.includes(' default_sessions: '));

    assert.strictEqual(defaultSessionsLine, 'READY default_sessions: General Agent=00000000-0000-4000-8000-000000000001');
    assert.doesNotMatch(defaultSessionsLine ?? '', /Curator Agent/);

    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = db.prepare(`
        SELECT title, session_type
        FROM chat_sessions
        ORDER BY title ASC
      `).all() as Array<{ title: string; session_type: string | null }>;

      assert.deepStrictEqual(rows, [{
        title: 'General Agent',
        session_type: null,
      }]);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('setup agent Codex browser-provider copy names the missing MCP setup path', () => {
  const message = formatCodexBrowserProviderMessage({
    ok: false,
    expectedCdpUrl: 'http://127.0.0.1:9222',
    serverName: null,
    reason: 'playwright_missing',
    message: 'Codex browser prerequisites missing: configure an enabled Playwright MCP server for Codex that targets http://127.0.0.1:9222.',
  });

  assert.match(message, /Codex Playwright MCP server "playwright" is missing/);
  assert.match(message, /shared Chrome CDP http:\/\/127\.0\.0\.1:9222/);
  assert.match(message, /Codex MCP setup: add server "playwright" with node scripts\/start-playwright-mcp\.js/);
});
