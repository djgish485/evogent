import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveUserFacingCommandDocument } from '../src/lib/commands';

const root = process.cwd();
const commandPath = path.join(root, '.claude', 'commands', 'curate-latest.md');
const command = fs.readFileSync(commandPath, 'utf8');

test('curate-latest is delivered as the phone-native lightweight command', () => {
  const resolved = resolveUserFacingCommandDocument({
    commandName: 'curate-latest',
    cwd: root,
    homeDir: path.join(root, '.test-no-global-commands'),
  });

  assert.ok(resolved);
  assert.equal(resolved.source, 'project');
  assert.match(resolved.body, /lightweight live-gap curation pass/i);
  assert.match(resolved.body, /Android is canonical production/);
  assert.match(resolved.body, /\.claude\/skills\/phone-browse\/SKILL\.md/);
  assert.match(resolved.body, /proved non-zero hidden display/);
  assert.match(resolved.body, /Never touch physical display 0/);
  assert.match(resolved.body, /browse-cache items endpoint is allowed here/);
  assert.match(resolved.body, /Discover configured sources dynamically/);
});

test('curate-latest has no VM browser, fixed-source, fake-thread, or zero-pressure recipe', () => {
  assert.doesNotMatch(command, /shared authenticated browser/i);
  assert.doesNotMatch(command, /Following tab selected/i);
  assert.doesNotMatch(command, /window\.scrollBy/i);
  assert.doesNotMatch(command, /1-3 targeted web searches/i);
  assert.doesNotMatch(command, /Do not browse or ship YouTube or Substack/i);
  assert.doesNotMatch(command, /topics that were active in the last 2-3/i);
  assert.doesNotMatch(command, /Ship one thread, one batch/i);
  assert.doesNotMatch(command, /latest-since-/i);
  assert.doesNotMatch(command, /curate-chat\.md/i);
  assert.doesNotMatch(command, /\$\{EVOGENT_API_CURL:-curl\}/);
  assert.match(command, /no fixed source count, account list, prior-topic loop, or required\s+search pattern/i);
  assert.match(command, /There is no minimum output/);
  assert.match(command, /Do not broaden the search or lower the bar merely to avoid an empty\s+result/i);
});

test('curate-latest submits stable truthful shipments and always arranges', () => {
  assert.match(command, /stable hidden `metadata\.shipment\.id`/);
  assert.match(command, /cluster of\s+2\+ unique selected root items/i);
  assert.match(command, /A singleton has no visible `metadata\.thread`/);
  assert.match(command, /shipment-singleton:<feed-item-id>/);
  assert.match(command, /considered = selected \+ rejected/);
  assert.match(command, /accepted \+ duplicates == cycleSummary\.selected/);
  assert.match(command, /Only `accepted` counts as newly shipped/);
  assert.match(command, /An empty pass still\s+submits `items: \[\]`/i);
  assert.match(command, /call `POST \$\{API_BASE\}\/api\/internal\/curate\/arrange`, even for\s+an empty pass/i);
  assert.match(command, /reports all eligible accepted-unviewed candidates\s+reviewed/i);
  assert.match(command, /list only active 2\+ member threads in `threads`/i);
});
