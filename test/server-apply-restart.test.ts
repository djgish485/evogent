import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

test('apply-restart restarts web immediately and defers worker restart until idle', () => {
  const serverSource = fs.readFileSync(path.join(process.cwd(), 'server.js'), 'utf8');
  const workerSource = fs.readFileSync(path.join(process.cwd(), 'worker.js'), 'utf8');

  assert.match(
    serverSource,
    /const WEB_RESTART_SERVICE_UNIT = 'evogent\.service';/,
  );
  assert.match(
    serverSource,
    /const WORKER_RESTART_SERVICE_UNIT = 'evogent-worker\.service';/,
  );
  assert.match(
    serverSource,
    /function buildRestartServicesCommand\(\)\s*\{\s*return `systemctl restart \$\{WEB_RESTART_SERVICE_UNIT\}`;\s*\}/,
  );
  assert.doesNotMatch(
    serverSource,
    /systemctl restart evogent-worker\.service evogent\.service/,
  );
  assert.match(
    serverSource,
    /writePendingWorkerRestartRequest\(\{/,
  );
  assert.match(
    serverSource,
    /worker restart deferred until idle/,
  );
  assert.match(
    workerSource,
    /function isWorkerIdleForRestart\(status\)/,
  );
  assert.match(
    workerSource,
    /await backgroundWorker\.close\(\);/,
  );
  assert.match(
    workerSource,
    /await shutdown\('idle-worker-restart'\);/,
  );
});

test('web startup marks restart consumed only after the ready banner', () => {
  const serverSource = fs.readFileSync(path.join(process.cwd(), 'server.js'), 'utf8');
  const readyLogIndex = serverSource.indexOf("console.log(`> Ready on http://${hostname}:${port}`);");
  const markReadyIndex = serverSource.indexOf('markRestartStateReadyOnStartup();', readyLogIndex);

  assert.notEqual(readyLogIndex, -1);
  assert.notEqual(markReadyIndex, -1);
  assert.ok(markReadyIndex > readyLogIndex);
  assert.doesNotMatch(serverSource, /backfillCodexContextMetricsOnStartup\(\);/);
});
