import assert from 'node:assert';
import { describe, test } from 'node:test';
import { getDataPath } from '@/lib/data-dir';
import {
  agentManager,
  DEFAULT_TIMEOUT_MS,
  MAX_PROGRESS_EVENTS,
} from './agent-manager.ts';

function resolveManagerModule(mod: Record<string, unknown>) {
  const candidate = (mod.default ?? mod) as {
    agentManager: typeof agentManager;
    DEFAULT_TIMEOUT_MS: number;
    MAX_PROGRESS_EVENTS: number;
  };
  return candidate;
}

describe('agent manager singleton', () => {
  test('same instance is returned on repeated import', async () => {
    const first = resolveManagerModule(await import('./agent-manager.ts'));
    const second = resolveManagerModule(await import('./agent-manager.ts'));

    assert.strictEqual(first.agentManager, second.agentManager);
    assert.strictEqual(first.agentManager, agentManager);
  });

  test('getRunningAgents() returns an array snapshot', () => {
    const running = agentManager.getRunningAgents();
    assert.ok(Array.isArray(running));
  });

  test('getAgentStatus() returns null for unknown id', () => {
    const status = agentManager.getAgentStatus('agent-does-not-exist');
    assert.strictEqual(status, null);
  });

  test('exports constants for max progress events and default timeout', () => {
    assert.strictEqual(MAX_PROGRESS_EVENTS, 600);
    assert.strictEqual(DEFAULT_TIMEOUT_MS, 600_000);
  });

  test('rebinds pre-discovered log readers to known agent ids', () => {
    const manager = agentManager as unknown as {
      findOrCreateLogReader: (logFile: string, knownAgentId?: string) => {
        agentId: string;
        readOffset: number;
        partialLineBuffer: string;
      };
    };
    const logFile = getDataPath('agent-logs', 'test-rebind-reader.jsonl');

    const initial = manager.findOrCreateLogReader(logFile);
    initial.readOffset = 123;
    initial.partialLineBuffer = 'partial';
    assert.ok(initial.agentId.startsWith('log:'));

    const rebound = manager.findOrCreateLogReader(logFile, 'agent-123');
    assert.strictEqual(rebound.agentId, 'agent-123');
    assert.strictEqual(rebound.readOffset, 0);
    assert.strictEqual(rebound.partialLineBuffer, '');
  });
});
