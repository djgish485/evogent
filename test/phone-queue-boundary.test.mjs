import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('phone runtime rejects queue use without loading Redis queue dependencies', () => {
  const script = String.raw`
    const Module = require('node:module');
    const originalLoad = Module._load;
    const forbidden = new Set(['bullmq', 'ioredis']);
    Module._load = function guardedLoad(request, parent, isMain) {
      if (forbidden.has(request)) {
        throw new Error('phone runtime loaded forbidden queue dependency: ' + request);
      }
      return originalLoad.call(this, request, parent, isMain);
    };

    process.env.EVOGENT_RUNTIME_PROFILE = 'phone';
    const queue = require('./lib/queue');
    assert.throws(
      () => queue.getBackgroundQueue(),
      (error) => error && error.code === 'EVOGENT_BACKGROUND_QUEUE_DISABLED',
    );
  `;

  const result = spawnSync(process.execPath, ['-e', `const assert = require('node:assert/strict');\n${script}`], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
});
