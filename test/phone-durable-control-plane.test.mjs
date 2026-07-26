import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tools = path.join(root, 'phone-paradigm', 'device', 'phone-tools');

function read(name) {
  return fs.readFileSync(path.join(tools, name), 'utf8');
}

test('Python durability and live-geometry unit tests pass', () => {
  const result = spawnSync(
    'python3',
    ['-m', 'unittest', 'discover', '-s', path.join(tools, 'tests'), '-p', 'test_durable_phone_tasks.py'],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('shell CLI proof exercises queued, leased, retry, ack, and quarantine', () => {
  const result = spawnSync('bash', [path.join(root, 'test', 'phone-durable-task-queue.sh')], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /shell test: ok/);
});

test('standing-interest browser gates cadence on durable submit and never orders the feed', () => {
  const source = read('browse-interests.py');
  const submitGate = source.indexOf('submit_persisted = True');
  const cadenceGate = source.indexOf('completed_ids = apply_submit_result(');
  assert.ok(submitGate >= 0 && cadenceGate > submitGate);
  assert.doesNotMatch(source, /UPDATE\s+feed\s+SET\s+display_order/i);
  assert.match(source, /interest-browse-outcomes\.json/);
  assert.match(read('interest_browse_runtime.py'), /cache_submit_failure/);
});

test('standing-interest Instagram taps derive from screenshot dimensions and report anomalies', () => {
  const source = read('browse-interests.py');
  assert.match(source, /png_dimensions\(geometry_shot\)/);
  assert.match(source, /derive_instagram_geometry\(width, height, rect\)/);
  assert.match(source, /instagram_grid_geometry_unavailable/);
  assert.doesNotMatch(source, /grid_top\s*\+\s*180/);
  assert.doesNotMatch(source, /"540",\s*"1700",\s*"540",\s*"500"/);
});

test('phone request consumers use a durable lease rather than remove-before-work', () => {
  const cycle = read('evogent-cycle.sh');
  const discovery = read('source-discovery.sh');
  assert.match(cycle, /durable_task_queue\.py/);
  assert.match(cycle, /claim --root "\$QUEUE_DIR"/);
  assert.match(cycle, /finish_queued_task "\$TASK_LEASE" retry/);
  assert.match(cycle, /source-discovery\.sh' --lease/);
  assert.doesNotMatch(cycle, /rm -f "\$NEXT_Q"/);
  assert.match(discovery, /finish_request ack discovery_fresh/);
  assert.match(discovery, /finish_request retry discovery_failure/);
});

test('nightly dream is a scheduler-owned durable due task, not a cycle-time window', () => {
  const scheduler = read('evogent-scheduler.sh');
  const cycle = read('evogent-cycle.sh');
  assert.match(scheduler, /ensure-nightly --root "\$SCHEDULED_TASK_ROOT"/);
  assert.match(scheduler, /claim --root "\$SCHEDULED_TASK_ROOT"/);
  assert.match(scheduler, /run_due_dream \|\| true/);
  assert.match(scheduler, /finish --root "\$SCHEDULED_TASK_ROOT".*--result ack/s);
  assert.doesNotMatch(cycle, /DREAM_AGE|HOUR=.*date \+%H|overnight taste pass/);
});
