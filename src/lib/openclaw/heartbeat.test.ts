import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { isOpenClawHeartbeatMessage } = require('./heartbeat.js') as {
  isOpenClawHeartbeatMessage: (message: unknown) => boolean;
};

test('isOpenClawHeartbeatMessage detects the user heartbeat prompt', () => {
  assert.equal(isOpenClawHeartbeatMessage({
    role: 'user',
    text: 'Read HEARTBEAT.md if it exists (workspace context). Follow it strictly.',
  }), true);
});

test('isOpenClawHeartbeatMessage detects heartbeat_respond JSON', () => {
  assert.equal(isOpenClawHeartbeatMessage({
    role: 'agent',
    text: JSON.stringify({
      status: 'recorded',
      outcome: 'no_change',
      notify: false,
      summary: 'Read /root/.openclaw/agents/curator/HEARTBEAT.md and no work was needed.',
    }),
  }), true);
});

test('isOpenClawHeartbeatMessage detects the heartbeat markdown template', () => {
  assert.equal(isOpenClawHeartbeatMessage({
    role: 'agent',
    text: '```markdown\n# Keep this file empty (or with only comments) to skip heartbeat API calls.\n```',
  }), true);
});

test('isOpenClawHeartbeatMessage leaves normal user messages visible', () => {
  assert.equal(isOpenClawHeartbeatMessage({
    role: 'user',
    text: 'I never got the new oauth link can you send it again?',
  }), false);
});

test('isOpenClawHeartbeatMessage leaves normal agent messages visible', () => {
  assert.equal(isOpenClawHeartbeatMessage({
    role: 'agent',
    text: 'I sent a fresh OAuth link to your email.',
  }), false);
});
