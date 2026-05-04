const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  getDefaultCacheRefreshIntervals,
  listInstalledCacheSources,
  parseCacheRefreshIntervals,
  parseConfigUsageLevel,
  readConfigUsageLevel,
} = require('./cache-refresh-config');

test('parseConfigUsageLevel falls back to medium', () => {
  assert.strictEqual(parseConfigUsageLevel('# Config'), 'medium');
  assert.strictEqual(parseConfigUsageLevel('## Usage Level\nTurbo\n'), 'medium');
});

test('getDefaultCacheRefreshIntervals returns tiered defaults', () => {
  assert.deepStrictEqual(getDefaultCacheRefreshIntervals('low'), {
    twitter: 60,
    hackernews: 120,
    substack: 240,
    youtube: 240,
  });
  assert.deepStrictEqual(getDefaultCacheRefreshIntervals('medium'), {
    twitter: 30,
    hackernews: 60,
    substack: 120,
    youtube: 120,
  });
  assert.deepStrictEqual(getDefaultCacheRefreshIntervals('high'), {
    twitter: 15,
    hackernews: 30,
    substack: 60,
    youtube: 60,
  });
});

test('parseCacheRefreshIntervals applies usage defaults before explicit overrides', () => {
  const intervals = parseCacheRefreshIntervals(`# Config

## Usage Level
Low

## Cache Intervals
- twitter: 10m
- hackernews: 2 hours
`);

  assert.deepStrictEqual(intervals, {
    twitter: 10,
    hackernews: 120,
    substack: 240,
    youtube: 240,
  });
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
