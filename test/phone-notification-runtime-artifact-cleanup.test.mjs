import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

for (const runtimeFile of ['server.js', 'worker.js']) {
  test(`${runtimeFile} scrubs legacy notification task artifacts before loading history`, () => {
    const source = fs.readFileSync(runtimeFile, 'utf8');
    const cleanupCall = source.indexOf(
      'scrubLegacyPhoneNotificationRuntimeArtifacts({',
    );
    const orchestratorConstruction = source.indexOf('new BrainOrchestrator(');

    assert.ok(cleanupCall >= 0, `${runtimeFile} must invoke startup cleanup`);
    assert.ok(
      orchestratorConstruction >= 0,
      `${runtimeFile} must construct its orchestrator`,
    );
    assert.ok(
      cleanupCall < orchestratorConstruction,
      `${runtimeFile} must clean disk before history enters memory`,
    );
  });
}
