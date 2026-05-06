const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  listInstalledCacheSources,
  parseConfigUsageLevel,
  readConfigUsageLevel,
} = require('./cache-refresh-config');

test('parseConfigUsageLevel falls back to medium', () => {
  assert.strictEqual(parseConfigUsageLevel('# Config'), 'medium');
  assert.strictEqual(parseConfigUsageLevel('## Usage Level\nTurbo\n'), 'medium');
});

test('readConfigUsageLevel reads config files', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-cache-refresh-'));
  const configPath = path.join(tempDir, 'config.md');
  fs.writeFileSync(configPath, '## Usage Level\nHigh\n', 'utf8');

  try {
    assert.strictEqual(readConfigUsageLevel(configPath), 'high');
    assert.strictEqual(readConfigUsageLevel(path.join(tempDir, 'missing.md')), 'medium');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('listInstalledCacheSources returns installed source skills', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-cache-sources-'));
  try {
    fs.mkdirSync(path.join(tempDir, '.claude', 'skills', 'tweet-cache'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, '.claude', 'skills', 'youtube-cache'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, '.claude', 'skills', 'tweet-cache', 'SKILL.md'), '# Tweet Cache\n', 'utf8');
    fs.writeFileSync(path.join(tempDir, '.claude', 'skills', 'youtube-cache', 'SKILL.md'), '# YouTube Cache\n', 'utf8');

    assert.deepStrictEqual(listInstalledCacheSources(tempDir), ['twitter', 'youtube']);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
