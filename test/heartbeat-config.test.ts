import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { parseCurationSchedule, readCurationScheduleConfig } from '../src/lib/heartbeat-config';
import { DEFAULT_CONFIG_CONTENT } from '../lib/brain-config.js';

const tempDirs: string[] = [];

function createConfig(content: string): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-config-test-'));
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

describe('readCurationScheduleConfig', () => {
  test('parses minute and hour formats', () => {
    const cases = [
      { min: '30 minutes', max: '2 hours', expectedMin: 30, expectedMax: 120 },
      { min: '30 min', max: '2 hours', expectedMin: 30, expectedMax: 120 },
      { min: '45 min', max: '6 hours', expectedMin: 45, expectedMax: 360 },
      { min: '60 minutes', max: '6 hours', expectedMin: 60, expectedMax: 360 },
    ];

    for (const testCase of cases) {
      const configPath = createConfig(`# Evogent Config

## Curation Schedule
- Minimum interval: ${testCase.min}
- Maximum interval: ${testCase.max}
`);

      assert.deepStrictEqual(readCurationScheduleConfig(configPath), {
        minIntervalMinutes: testCase.expectedMin,
        maxIntervalMinutes: testCase.expectedMax,
      });
    }
  });

  test('falls back to defaults when section is missing', () => {
    const configPath = createConfig(`# Evogent Config

## Curation Philosophy
Prioritize:
- high signal content
`);

    assert.deepStrictEqual(readCurationScheduleConfig(configPath), {
      minIntervalMinutes: 90,
      maxIntervalMinutes: 240,
    });
  });

  test('falls back to defaults for garbage values', () => {
    const configPath = createConfig(`# Evogent Config

## Curation Schedule
- Minimum interval: whenever
- Maximum interval: maybe later
`);

    assert.deepStrictEqual(readCurationScheduleConfig(configPath), {
      minIntervalMinutes: 90,
      maxIntervalMinutes: 240,
    });
  });

  test('falls back to defaults for empty files', () => {
    const configPath = createConfig('');

    assert.deepStrictEqual(readCurationScheduleConfig(configPath), {
      minIntervalMinutes: 90,
      maxIntervalMinutes: 240,
    });
  });

  test('default config content uses the active medium curation cadence', () => {
    assert.deepStrictEqual(parseCurationSchedule(DEFAULT_CONFIG_CONTENT), {
      minIntervalMinutes: 90,
      maxIntervalMinutes: 240,
    });
  });

  test('uses usage-level defaults when schedule section is missing', () => {
    const configPath = createConfig(`# Evogent Config

## Usage Level
Low
`);

    assert.deepStrictEqual(readCurationScheduleConfig(configPath), {
      minIntervalMinutes: 240,
      maxIntervalMinutes: 480,
    });
  });

  test('explicit curation schedule values override usage-level defaults', () => {
    const configPath = createConfig(`# Evogent Config

## Usage Level
Low

## Curation Schedule
- Minimum interval: 90 minutes
- Maximum interval: 5 hours
`);

    assert.deepStrictEqual(readCurationScheduleConfig(configPath), {
      minIntervalMinutes: 90,
      maxIntervalMinutes: 300,
    });
  });

  test('missing schedule values fall back to usage-level defaults', () => {
    const configPath = createConfig(`# Evogent Config

## Usage Level
High

## Curation Schedule
- Minimum interval: 45 minutes
`);

    assert.deepStrictEqual(readCurationScheduleConfig(configPath), {
      minIntervalMinutes: 45,
      maxIntervalMinutes: 120,
    });
  });
});
