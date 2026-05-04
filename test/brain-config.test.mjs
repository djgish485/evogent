import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_CONFIG_CONTENT,
  DEFAULT_BRAIN_PROVIDER,
  DEFAULT_CLAUDE_REASONING_EFFORT,
  DEFAULT_CODEX_REASONING_EFFORT,
  DEFAULT_CODE_FIX_REASONING_EFFORT,
  deriveCodexReasoningEffortFromUsageLevel,
  parseBrainConfig,
  parseBackgroundSourceBrowsingEnabled,
  readAutomaticCurationEnabled,
  readBackgroundSourceBrowsingEnabled,
  readCodeFixReasoningEffort,
  resolveCodeFixReasoningEffortForBrainProvider,
  resolveCodeFixReasoningEffortForProvider,
  updateBrainConfigContent,
  updateCodeFixReasoningEffortConfigContent,
} from '../lib/brain-config.js';

test('parseBrainConfig defaults to Claude when provider is missing', () => {
  const parsed = parseBrainConfig('# Evogent Config\n');

  assert.equal(parsed.provider, DEFAULT_BRAIN_PROVIDER);
  assert.equal(parsed.claudeReasoningEffort, DEFAULT_CLAUDE_REASONING_EFFORT);
  assert.equal(parsed.codexReasoningEffort, DEFAULT_CODEX_REASONING_EFFORT);
  assert.equal(parsed.providerDisplayName, 'Claude Code');
  assert.equal(parsed.providerBinary, 'claude');
});

test('parseBrainConfig derives missing Codex reasoning effort from usage level', () => {
  assert.equal(parseBrainConfig('## Usage Level\nLow\n').codexReasoningEffort, 'low');
  assert.equal(parseBrainConfig('## Usage Level\nMedium\n').codexReasoningEffort, 'medium');
  assert.equal(parseBrainConfig('## Usage Level\nHigh\n').codexReasoningEffort, 'high');
  assert.equal(parseBrainConfig('# Evogent Config\n').codexReasoningEffort, 'medium');
});

test('parseBrainConfig keeps explicit Codex reasoning effort over usage level', () => {
  const parsed = parseBrainConfig(`
# Evogent Config

## Usage Level
Low

## Codex Reasoning Effort
High
`);

  assert.equal(parsed.codexReasoningEffort, 'high');
});

test('deriveCodexReasoningEffortFromUsageLevel maps install choices directly', () => {
  assert.equal(deriveCodexReasoningEffortFromUsageLevel('Low'), 'low');
  assert.equal(deriveCodexReasoningEffortFromUsageLevel('Medium'), 'medium');
  assert.equal(deriveCodexReasoningEffortFromUsageLevel('High'), 'high');
});

test('parseBrainConfig recognizes Claude reasoning effort levels', () => {
  const parsed = parseBrainConfig(`
# Evogent Config

## Brain Provider
Claude Code

## Claude Reasoning Effort
Max
`);

  assert.equal(parsed.provider, 'claude');
  assert.equal(parsed.claudeReasoningEffort, 'max');
});

test('parseBrainConfig recognizes Codex provider and reasoning effort', () => {
  const parsed = parseBrainConfig(`
# Evogent Config

## Brain Provider
Codex CLI

## Codex Model
gpt-5.5-mini

## Codex Reasoning Effort
XHigh
`);

  assert.equal(parsed.provider, 'codex');
  assert.equal(parsed.codexReasoningEffort, 'xhigh');
  assert.equal(parsed.codexModel, 'gpt-5.5-mini');
  assert.equal(parsed.providerDisplayName, 'Codex CLI');
  assert.equal(parsed.providerBinary, 'codex');
});

test('updateBrainConfigContent switches provider sections without disturbing the rest of the config', () => {
  const nextContent = updateBrainConfigContent(DEFAULT_CONFIG_CONTENT, {
    provider: 'codex',
    codexModel: 'gpt-5.5-mini',
    codexReasoningEffort: 'xhigh',
  });

  assert.match(nextContent, /## Brain Provider\nCodex CLI\n/i);
  assert.match(nextContent, /## Codex Model\ngpt-5\.5-mini\n/i);
  assert.match(nextContent, /## Codex Reasoning Effort\nXHigh\n/i);
  assert.match(nextContent, /## Usage Level\nMedium\n/i);

  const parsed = parseBrainConfig(nextContent);
  assert.equal(parsed.provider, 'codex');
  assert.equal(parsed.codexModel, 'gpt-5.5-mini');
  assert.equal(parsed.codexReasoningEffort, 'xhigh');
});

test('DEFAULT_CONFIG_CONTENT documents the active medium curation cadence', () => {
  assert.match(DEFAULT_CONFIG_CONTENT, /## Automatic Curation\nOn\n/i);
  assert.match(DEFAULT_CONFIG_CONTENT, /## Background Source Browsing\nOn\n/i);
  assert.match(DEFAULT_CONFIG_CONTENT, /## Curation Schedule\n[\s\S]*Minimum interval: 90 minutes/i);
  assert.match(DEFAULT_CONFIG_CONTENT, /Maximum interval: 4 hours/i);
  assert.match(DEFAULT_CONFIG_CONTENT, /Source caches refresh ahead of visible curation/i);
});

test('parseBackgroundSourceBrowsingEnabled defaults to enabled for existing configs', () => {
  assert.equal(parseBackgroundSourceBrowsingEnabled('# Evogent Config\n'), true);
  assert.equal(parseBackgroundSourceBrowsingEnabled('## Background Source Browsing\nOff\n'), false);
});

test('updateBrainConfigContent inserts provider sections when they are missing', () => {
  const nextContent = updateBrainConfigContent('# Evogent Config\n\n## Agent Name\nEvogent\n', {
    provider: 'claude',
    codexModel: 'gpt-5.5',
    codexReasoningEffort: 'medium',
  });

  assert.match(nextContent, /## Brain Provider\nClaude Code\n/i);
  assert.match(nextContent, /## Codex Model\ngpt-5\.5\n/i);
  assert.match(nextContent, /## Codex Reasoning Effort\nMedium\n/i);
});

test('readAutomaticCurationEnabled reads the toggle from config.md', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-config-'));
  try {
    const configPath = path.join(tempDir, 'config.md');

    fs.writeFileSync(configPath, [
      '# Evogent Config',
      '',
      '## Automatic Curation',
      'Off',
      '',
    ].join('\n'), 'utf8');

    assert.equal(readAutomaticCurationEnabled(configPath), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('parseBrainConfig defaults Code-Fix Reasoning Effort to high', () => {
  const parsed = parseBrainConfig('# Evogent Config\n');
  assert.equal(parsed.codeFixReasoningEffort, DEFAULT_CODE_FIX_REASONING_EFFORT);
});

test('parseBrainConfig reads Code-Fix Reasoning Effort levels', () => {
  const parsed = parseBrainConfig(`
# Evogent Config

## Code-Fix Reasoning Effort
Low
`);
  assert.equal(parsed.codeFixReasoningEffort, 'low');
});

test('updateCodeFixReasoningEffortConfigContent upserts the section without disturbing others', () => {
  const updated = updateCodeFixReasoningEffortConfigContent(DEFAULT_CONFIG_CONTENT, 'low');
  assert.match(updated, /## Code-Fix Reasoning Effort\nLow\n/i);
  assert.match(updated, /## Brain Provider\nClaude Code\n/i);
  assert.match(updated, /## Automatic Curation\nOn\n/i);
  assert.equal(parseBrainConfig(updated).codeFixReasoningEffort, 'low');
});

test('updateCodeFixReasoningEffortConfigContent inserts the section when missing', () => {
  const minimal = '# Evogent Config\n\n## Agent Name\nEvogent\n';
  const updated = updateCodeFixReasoningEffortConfigContent(minimal, 'max');
  assert.match(updated, /## Code-Fix Reasoning Effort\nMax\n/i);
  assert.equal(parseBrainConfig(updated).codeFixReasoningEffort, 'max');
});

test('resolveCodeFixReasoningEffortForProvider clamps max to xhigh for Codex', () => {
  assert.equal(resolveCodeFixReasoningEffortForProvider('max', 'codex'), 'xhigh');
  assert.equal(resolveCodeFixReasoningEffortForProvider('max', 'claude'), 'max');
  assert.equal(resolveCodeFixReasoningEffortForProvider('low', 'codex'), 'low');
  assert.equal(resolveCodeFixReasoningEffortForProvider('high', 'claude'), 'high');
});

test('resolveCodeFixReasoningEffortForBrainProvider reads the target provider reasoning source', () => {
  const content = `
# Evogent Config

## Brain Provider
Codex CLI

## Claude Reasoning Effort
Max

## Codex Reasoning Effort
Medium

## Code-Fix Reasoning Effort
Low
`;

  assert.equal(resolveCodeFixReasoningEffortForBrainProvider(content, 'claude'), 'max');
  assert.equal(resolveCodeFixReasoningEffortForBrainProvider(content, 'codex'), 'medium');
  assert.equal(resolveCodeFixReasoningEffortForBrainProvider(content, 'codex', {
    codexReasoningEffort: 'xhigh',
  }), 'xhigh');
  assert.equal(resolveCodeFixReasoningEffortForBrainProvider('# Evogent Config\n', 'claude'), DEFAULT_CLAUDE_REASONING_EFFORT);
});

test('brain provider switch content can sync Code-Fix Reasoning Effort to the new brain', () => {
  const codexSourceContent = `
# Evogent Config

## Brain Provider
Claude Code

## Claude Reasoning Effort
Max

## Codex Reasoning Effort
Medium

## Code-Fix Reasoning Effort
Max
`;

  const codexProviderContent = updateBrainConfigContent(codexSourceContent, {
    provider: 'codex',
    codexReasoningEffort: 'xhigh',
  });
  const syncedCodexContent = updateCodeFixReasoningEffortConfigContent(
    codexProviderContent,
    resolveCodeFixReasoningEffortForBrainProvider(codexSourceContent, 'codex', {
      codexReasoningEffort: 'xhigh',
    }),
  );

  assert.match(syncedCodexContent, /## Brain Provider\nCodex CLI\n/i);
  assert.match(syncedCodexContent, /## Codex Reasoning Effort\nXHigh\n/i);
  assert.match(syncedCodexContent, /## Code-Fix Reasoning Effort\nXHigh\n/i);
  assert.equal(parseBrainConfig(syncedCodexContent).codeFixReasoningEffort, 'xhigh');

  const claudeSourceContent = `
# Evogent Config

## Brain Provider
Codex CLI

## Claude Reasoning Effort
Max

## Codex Reasoning Effort
XHigh

## Code-Fix Reasoning Effort
XHigh
`;

  const claudeProviderContent = updateBrainConfigContent(claudeSourceContent, {
    provider: 'claude',
    codexReasoningEffort: 'xhigh',
  });
  const syncedClaudeContent = updateCodeFixReasoningEffortConfigContent(
    claudeProviderContent,
    resolveCodeFixReasoningEffortForBrainProvider(claudeSourceContent, 'claude'),
  );

  assert.match(syncedClaudeContent, /## Brain Provider\nClaude Code\n/i);
  assert.match(syncedClaudeContent, /## Code-Fix Reasoning Effort\nMax\n/i);
  assert.equal(parseBrainConfig(syncedClaudeContent).codeFixReasoningEffort, 'max');
});

test('readCodeFixReasoningEffort reads the value from config.md', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-config-'));
  try {
    const configPath = path.join(tempDir, 'config.md');
    fs.writeFileSync(configPath, [
      '# Evogent Config',
      '',
      '## Code-Fix Reasoning Effort',
      'Medium',
      '',
    ].join('\n'), 'utf8');
    assert.equal(readCodeFixReasoningEffort(configPath), 'medium');
    assert.equal(readCodeFixReasoningEffort(path.join(tempDir, 'missing.md')), DEFAULT_CODE_FIX_REASONING_EFFORT);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('DEFAULT_CONFIG_CONTENT includes a Code-Fix Reasoning Effort section', () => {
  assert.match(DEFAULT_CONFIG_CONTENT, /## Code-Fix Reasoning Effort\nHigh\n/i);
});

test('DEFAULT_CONFIG_CONTENT aligns Codex reasoning with medium usage', () => {
  assert.match(DEFAULT_CONFIG_CONTENT, /## Codex Reasoning Effort\nMedium\n/i);
  assert.match(DEFAULT_CONFIG_CONTENT, /## Usage Level\nMedium\n/i);
});

test('readBackgroundSourceBrowsingEnabled reads the toggle from config.md', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-config-'));
  try {
    const configPath = path.join(tempDir, 'config.md');

    fs.writeFileSync(configPath, [
      '# Evogent Config',
      '',
      '## Background Source Browsing',
      'Off',
      '',
    ].join('\n'), 'utf8');

    assert.equal(readBackgroundSourceBrowsingEnabled(configPath), false);
    assert.equal(readBackgroundSourceBrowsingEnabled(path.join(tempDir, 'missing.md')), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
