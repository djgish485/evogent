import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import {
  getPhoneCycleRequestPath,
  requestPhoneCycle,
} from './phone-cycle-signal';

let tempDir = '';
let originalRequestPath: string | undefined;

afterEach(() => {
  if (originalRequestPath === undefined) {
    delete process.env.EVOGENT_PHONE_CYCLE_REQUEST_PATH;
  } else {
    process.env.EVOGENT_PHONE_CYCLE_REQUEST_PATH = originalRequestPath;
  }
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

test('phone cycle signal is durable and coalesces repeated requests', () => {
  originalRequestPath = process.env.EVOGENT_PHONE_CYCLE_REQUEST_PATH;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-phone-cycle-'));
  process.env.EVOGENT_PHONE_CYCLE_REQUEST_PATH = path.join(tempDir, 'request.json');

  const first = requestPhoneCycle({ reason: 'app_open_auto', triggeredBy: 'activity:app_open' });
  const second = requestPhoneCycle({ reason: 'max_interval_elapsed', triggeredBy: 'timer' });

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.request.id, first.request.id);
  assert.equal(getPhoneCycleRequestPath(), process.env.EVOGENT_PHONE_CYCLE_REQUEST_PATH);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(first.path, 'utf8')),
    first.request,
  );
  assert.equal(fs.statSync(first.path).mode & 0o777, 0o600);
});
