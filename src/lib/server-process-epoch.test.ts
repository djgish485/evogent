import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

type EpochModule = {
  getServerProcessEpoch: () => string;
};

test('route-bundle copies share one process boot epoch', async () => {
  const moduleUrl = pathToFileURL(
    path.join(process.cwd(), 'src/lib/server-process-epoch.ts'),
  ).href;
  const first = await import(`${moduleUrl}?bundle=one`) as EpochModule;
  const second = await import(`${moduleUrl}?bundle=two`) as EpochModule;

  assert.match(first.getServerProcessEpoch(), /^[0-9a-f-]{36}$/);
  assert.strictEqual(second.getServerProcessEpoch(), first.getServerProcessEpoch());
});
