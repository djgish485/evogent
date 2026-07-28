import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('server startup kicks the durable chat-reply push outbox after publishing loopback auth', () => {
  const serverSource = fs.readFileSync(path.join(repoRoot, 'server.js'), 'utf8');
  const publishAt = serverSource.lastIndexOf('publishServerLoopbackSecret();');
  const drainAt = serverSource.lastIndexOf('await startChatReplyPushOutboxOnStartup();');
  const readyAt = serverSource.lastIndexOf('console.log(`> Ready on http://');

  assert.ok(publishAt >= 0, 'server must publish the restart-bound loopback secret');
  assert.ok(drainAt > publishAt, 'startup drain must run after loopback auth is available');
  assert.ok(readyAt > drainAt, 'startup drain must be kicked before the server reports ready');

  const routeSource = fs.readFileSync(
    path.join(
      repoRoot,
      'src/app/api/internal/chat-reply-push-outbox/drain/route.ts',
    ),
    'utf8',
  );
  assert.match(routeSource, /startChatReplyPushOutbox\(\)/);
});
