import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tools = path.join(root, 'phone-paradigm', 'device', 'phone-tools');
const cycle = fs.readFileSync(path.join(tools, 'evogent-cycle.sh'), 'utf8');
const helper = fs.readFileSync(
  path.join(tools, 'automatic_diagnosis_budget.py'),
  'utf8',
);

test('every automatic barren-source diagnosis passes through one durable daily claim', () => {
  const harvest = cycle.slice(
    cycle.indexOf('harvest_watch(){'),
    cycle.indexOf('AUTO_CUR="$(cfg'),
  );
  const claim = harvest.indexOf(
    'diagnosis_decision=$(automatic_diagnosis_claim "$src" "$n")',
  );
  const dispatch = harvest.indexOf(
    'codex exec --model "$DIAGNOSIS_MODEL"',
  );

  assert.ok(claim >= 0);
  assert.ok(dispatch > claim, 'the budget claim must commit before provider launch');
  assert.match(harvest, /if \[ "\$diagnosis_claimed" = 1 \]; then/);
  assert.match(harvest, /automatic_diagnosis_clear "\$src"/);
  const failedOutcome = harvest.slice(
    harvest.indexOf('if [ "$outcome" != empty ]; then'),
    harvest.indexOf('rm -f "$failure"', harvest.indexOf('if [ "$outcome" != empty ]; then')),
  );
  assert.doesNotMatch(failedOutcome, /automatic_diagnosis_clear/);
  assert.match(
    failedOutcome,
    /automatic_diagnosis_reset_streak "\$src"/,
  );
  assert.doesNotMatch(
    harvest,
    /\[\s*\$\(\(\s*n\s*%\s*3\s*\)\)\s*-eq\s*0\s*\][\s\S]{0,160}codex exec/,
  );
});

test('warning stays truthful when no new threshold is due or the ledger fails closed', () => {
  assert.match(
    cycle,
    /Automatic diagnosis is limited to one source per day; this warning stays visible/,
  );
  assert.doesNotMatch(cycle, /has queued a bounded diagnosis/);
  assert.match(cycle, /budget_unavailable/);
});

test('diagnosis ledger uses a bounded, atomic, private, fail-closed history', () => {
  assert.match(helper, /MAX_EXACT_CLAIMS = 400/);
  assert.match(helper, /closedThroughServiceDate/);
  assert.match(helper, /fcntl\.flock\(descriptor, fcntl\.LOCK_EX\)/);
  assert.match(helper, /os\.replace\(temp, path\)/);
  assert.match(helper, /os\.fchmod\(descriptor, 0o600\)/);
  assert.match(helper, /os\.chmod\(path, 0o600\)/);
  assert.match(helper, /service_date <= closed_through/);
  assert.match(helper, /def reset_source_streak\(/);
  assert.match(helper, /record\["handledThrough"\] = max\(handled, threshold\)/);
});
