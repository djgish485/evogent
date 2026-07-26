import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  assertSafeInternalUrl,
  getInternalRequestHeaders,
} = require('../lib/internal-request-auth.js');

test('internal request header is absent outside the phone server process', () => {
  const before = process.env.EVOGENT_SERVER_LOOPBACK_SECRET;
  delete process.env.EVOGENT_SERVER_LOOPBACK_SECRET;
  try {
    assert.deepEqual(getInternalRequestHeaders({ Accept: 'application/json' }), {
      Accept: 'application/json',
    });
  } finally {
    if (before === undefined) delete process.env.EVOGENT_SERVER_LOOPBACK_SECRET;
    else process.env.EVOGENT_SERVER_LOOPBACK_SECRET = before;
  }
});

test('internal request header preserves caller headers and uses the process credential', () => {
  const before = process.env.EVOGENT_SERVER_LOOPBACK_SECRET;
  const beforePort = process.env.PORT;
  process.env.EVOGENT_SERVER_LOOPBACK_SECRET = 'ephemeral-process-credential';
  process.env.PORT = '3001';
  try {
    assert.deepEqual(getInternalRequestHeaders({ 'Content-Type': 'application/json' }), {
      'Content-Type': 'application/json',
      'X-Evogent-Server-Secret': 'ephemeral-process-credential',
    });
    assert.doesNotThrow(() => assertSafeInternalUrl('http://127.0.0.1:3001/api/internal/ping'));
    assert.throws(
      () => assertSafeInternalUrl('http://example.test/api/internal/ping'),
      /exact loopback origin/
    );
    assert.throws(
      () => assertSafeInternalUrl('http://127.0.0.1:3002/api/internal/ping'),
      /exact loopback origin/
    );
  } finally {
    if (before === undefined) delete process.env.EVOGENT_SERVER_LOOPBACK_SECRET;
    else process.env.EVOGENT_SERVER_LOOPBACK_SECRET = before;
    if (beforePort === undefined) delete process.env.PORT;
    else process.env.PORT = beforePort;
  }
});
