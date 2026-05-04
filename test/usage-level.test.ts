import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { parseUsageLevel, readUsageLevelConfig } from '../src/lib/usage-level';

const tempDirs: string[] = [];

function createConfig(content: string): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-usage-level-test-'));
  tempDirs.push(tempDir);
  const configPath = path.join(tempDir, 'config.md');
  fs.writeFileSync(configPath, content, 'utf8');
  return configPath;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

describe('usage-level config parser', () => {
  test('parses low usage level', () => {
    const parsed = parseUsageLevel(`# Evogent Config

## Usage Level
Low
`);

    assert.deepStrictEqual(parsed, {
      level: 'low',
      subAgentModel: 'haiku',
      enrichmentModel: 'sonnet',
      reflectionModel: 'sonnet',
      defaultMinInterval: 240,
      defaultMaxInterval: 480,
      reflectionFrequency: 'weekly',
    });
  });

  test('parses medium usage level', () => {
    const parsed = parseUsageLevel(`# Evogent Config

## Usage Level
medium
`);

    assert.deepStrictEqual(parsed, {
      level: 'medium',
      subAgentModel: 'sonnet',
      enrichmentModel: 'sonnet',
      reflectionModel: 'sonnet',
      defaultMinInterval: 90,
      defaultMaxInterval: 240,
      reflectionFrequency: 'daily',
    });
  });

  test('parses high usage level case-insensitively', () => {
    const parsed = parseUsageLevel(`# Evogent Config

## Usage Level
HIGH
`);

    assert.deepStrictEqual(parsed, {
      level: 'high',
      subAgentModel: 'opus',
      enrichmentModel: 'opus',
      reflectionModel: 'opus',
      defaultMinInterval: 45,
      defaultMaxInterval: 120,
      reflectionFrequency: 'daily',
    });
  });

  test('falls back to medium when section is missing', () => {
    const parsed = parseUsageLevel(`# Evogent Config

## Curation Philosophy
Prioritize:
- high signal
`);

    assert.strictEqual(parsed.level, 'medium');
    assert.strictEqual(parsed.subAgentModel, 'sonnet');
  });

  test('falls back to medium when value is invalid', () => {
    const parsed = parseUsageLevel(`# Evogent Config

## Usage Level
Turbo
`);

    assert.strictEqual(parsed.level, 'medium');
    assert.strictEqual(parsed.defaultMinInterval, 90);
    assert.strictEqual(parsed.defaultMaxInterval, 240);
  });

  test('readUsageLevelConfig reads from file and falls back when missing', () => {
    const validPath = createConfig(`# Evogent Config

## Usage Level
Low
`);

    assert.strictEqual(readUsageLevelConfig(validPath).level, 'low');
    assert.strictEqual(readUsageLevelConfig('/tmp/does-not-exist.md').level, 'medium');
  });
});
