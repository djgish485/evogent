import assert from 'node:assert';
import { describe, test } from 'node:test';
import {
  parseAutomaticCurationEnabled,
  parseBackgroundSourceBrowsingEnabled,
  updateAutomaticCurationConfigContent,
  updateBackgroundSourceBrowsingConfigContent,
} from './automatic-curation-config';

describe('automatic curation config helpers', () => {
  test('defaults to enabled when the section is missing', () => {
    assert.strictEqual(parseAutomaticCurationEnabled('# Evogent Config\n'), true);
  });

  test('parses the automatic curation section', () => {
    assert.strictEqual(parseAutomaticCurationEnabled([
      '# Evogent Config',
      '',
      '## Automatic Curation',
      'Off',
      '',
    ].join('\n')), false);
  });

  test('updates the automatic curation section in config content', () => {
    const updated = updateAutomaticCurationConfigContent([
      '# Evogent Config',
      '',
      '## Usage Level',
      'Medium',
      '',
    ].join('\n'), false);

    assert.match(updated, /## Automatic Curation\nOff\n/);
    assert.strictEqual(parseAutomaticCurationEnabled(updated), false);
  });

  test('defaults background source browsing to enabled when the section is missing', () => {
    assert.strictEqual(parseBackgroundSourceBrowsingEnabled('# Evogent Config\n'), true);
  });

  test('updates the background source browsing section in config content', () => {
    const updated = updateBackgroundSourceBrowsingConfigContent([
      '# Evogent Config',
      '',
      '## Automatic Curation',
      'On',
      '',
    ].join('\n'), false);

    assert.match(updated, /## Background Source Browsing\nOff\n/);
    assert.strictEqual(parseBackgroundSourceBrowsingEnabled(updated), false);
  });
});
