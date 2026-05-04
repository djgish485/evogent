import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const rootDir = process.cwd();

test('curation command documents rejected-only candidate logs with required text', async () => {
  const curateCommand = await fs.readFile(path.join(rootDir, '.claude', 'commands', 'curate.md'), 'utf8');

  assert.match(curateCommand, /`candidates` are only for rejected items/i);
  assert.match(curateCommand, /"text": "candidate text or excerpt"/);
  assert.match(
    curateCommand,
    /every included candidate must have `cycleId`, `sourceId`, `text`, `reason`, `rejectionReason`, and `timestamp`/i,
  );
});

test('curation command requires Solutions articles to attach to an owner thread', async () => {
  const curateCommand = await fs.readFile(path.join(rootDir, '.claude', 'commands', 'curate.md'), 'utf8');

  assert.match(curateCommand, /best-fit selected thread that raised the problem/i);
  assert.match(curateCommand, /parentId` to a real primary member of that same thread/i);
  assert.match(curateCommand, /relationship: "analysis"/);
  assert.match(curateCommand, /metadata\.analysisScope: "thread-solving"/);
  assert.match(curateCommand, /no selected thread defensibly owns the problem/i);

  assert.doesNotMatch(curateCommand, /cycle problem-solving article is the standalone exception/i);
  assert.doesNotMatch(curateCommand, /ship the article as a STANDALONE feed item/i);
  assert.doesNotMatch(curateCommand, /cycle article stays standalone/i);
  assert.doesNotMatch(curateCommand, /cycle-holistic/i);
  assert.doesNotMatch(curateCommand, /For the cycle problem-solving article, keep `relationship: null` and `parentId: null`/i);
});

test('runtime output contracts mirror the curate-submit candidate requirements', async () => {
  const contractsDoc = await fs.readFile(path.join(rootDir, 'docs', 'reference', 'runtime-output-contracts.md'), 'utf8');

  assert.match(contractsDoc, /Use `candidates` only for rejected items/i);
  assert.match(contractsDoc, /"text": "candidate text or excerpt"/);
  assert.match(contractsDoc, /every included candidate must provide the same fields the API validator expects/i);
});
