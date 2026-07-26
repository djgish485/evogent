import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import {
  claimConfigApplyTask,
  configContentHash,
  enqueueConfigApplyTask,
  reconcileRunningConfigApplyTasks,
} from '@/lib/config-apply-tasks.js';
import { getDb } from '@/lib/db/client';
import { insertOrIgnoreFeedItem } from '@/lib/db/feed';

type GlobalWithDb = typeof globalThis & {
  evogentDb?: { close: () => void };
};

const globalWithDb = globalThis as GlobalWithDb;
let tempDir = '';
let originalDataDir: string | undefined;
let originalDbPath: string | undefined;

describe('config apply task executor', { concurrency: false }, () => {
  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-config-apply-'));
    originalDataDir = process.env.DATA_DIR;
    originalDbPath = process.env.MEDIA_AGENT_DB_PATH;
    process.env.DATA_DIR = tempDir;
    process.env.MEDIA_AGENT_DB_PATH = path.join(tempDir, 'media-agent.db');
  });

  beforeEach(() => {
    if (globalWithDb.evogentDb) {
      globalWithDb.evogentDb.close();
      delete globalWithDb.evogentDb;
    }
    for (const entry of fs.readdirSync(tempDir)) {
      fs.rmSync(path.join(tempDir, entry), { recursive: true, force: true });
    }
  });

  afterEach(() => {
    if (globalWithDb.evogentDb) {
      globalWithDb.evogentDb.close();
      delete globalWithDb.evogentDb;
    }
  });

  after(() => {
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    if (originalDbPath === undefined) delete process.env.MEDIA_AGENT_DB_PATH;
    else process.env.MEDIA_AGENT_DB_PATH = originalDbPath;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function insertConfigSuggestion(options: {
    id?: string;
    status?: 'pending' | 'dispatched';
    proposedValue?: string;
  } = {}): void {
    const id = options.id ?? 'config-suggestion';
    const proposedValue = options.proposedValue ?? 'High';
    insertOrIgnoreFeedItem({
      id,
      type: 'suggestion',
      title: 'Use high mode',
      text: 'Use high mode',
      source: 'curator',
      sourceId: id,
      publishedAt: '2026-07-25T20:00:00.000Z',
      metadata: {
        suggestionType: 'config',
        suggestionStatus: options.status ?? 'pending',
        configFile: 'data/config.md',
        configField: 'Usage Level',
        proposedValue,
      },
    });
  }

  function journalTransition() {
    const before = '# Config\n\n## Usage Level\n\nMedium\n';
    const after = '# Config\n\n## Usage Level\n\nHigh\n';
    return {
      before,
      after,
      journal: {
        preContentSha256: configContentHash(before),
        postContentSha256: configContentHash(after),
        result: {
          changed: true,
          method: 'section-replace',
          target: 'data/config.md',
        },
      },
    };
  }

  test('executes only the authoritative taskId and records a replay-safe terminal status', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'config.md'),
      '# Config\n\n## Usage Level\n\nMedium\n',
      { mode: 0o600 },
    );
    insertConfigSuggestion();
    const enqueued = enqueueConfigApplyTask(getDb(), {
      taskId: 'config-task-1',
      suggestionId: 'config-suggestion',
      target: 'config',
      sectionName: 'Usage Level',
      proposedValue: 'High',
    });
    assert.strictEqual(enqueued.duplicate, false);

    const { POST } = await import('./route');
    const response = await POST(new Request('http://127.0.0.1/api/internal/config-apply-tasks/execute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskId: 'config-task-1' }),
    }));
    const body = await response.json() as Record<string, unknown>;

    assert.strictEqual(response.status, 200);
    assert.strictEqual(body.ok, true);
    assert.match(fs.readFileSync(path.join(tempDir, 'config.md'), 'utf8'), /## Usage Level\n\nHigh/);
    const row = getDb().prepare('SELECT metadata FROM feed WHERE id = ?')
      .get('config-suggestion') as { metadata: string };
    const metadata = JSON.parse(row.metadata) as Record<string, unknown>;
    assert.strictEqual(metadata.configApplyStatus, 'applied');
    assert.strictEqual(metadata.suggestionStatus, 'accepted');
    assert.strictEqual(metadata.taskId, 'config-task-1');
    assert.strictEqual(fs.statSync(path.join(tempDir, 'config.md')).mode & 0o777, 0o600);

    const taskRow = getDb().prepare(`
      SELECT status, proposed_value, payload_sha256, result_json
      FROM config_apply_tasks
      WHERE task_id = ?
    `).get('config-task-1') as {
      status: string;
      proposed_value: string;
      payload_sha256: string;
      result_json: string;
    };
    assert.strictEqual(taskRow.status, 'applied');
    assert.strictEqual(taskRow.proposed_value, 'High');
    assert.match(taskRow.payload_sha256, /^[a-f0-9]{64}$/);
    assert.strictEqual(JSON.parse(taskRow.result_json).target, 'data/config.md');

    const replay = await POST(new Request('http://127.0.0.1/api/internal/config-apply-tasks/execute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskId: 'config-task-1' }),
    }));
    const replayBody = await replay.json() as Record<string, unknown>;
    assert.strictEqual(replay.status, 200);
    assert.strictEqual(replayBody.ok, true);
    assert.strictEqual(replayBody.alreadyApplied, true);
    assert.match(fs.readFileSync(path.join(tempDir, 'config.md'), 'utf8'), /## Usage Level\n\nHigh/);
  });

  test('rejects an arbitrary caller-supplied task payload', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'config.md'),
      '# Config\n\n## Usage Level\n\nMedium\n',
      { mode: 0o600 },
    );
    insertConfigSuggestion();

    const { POST } = await import('./route');
    const response = await POST(new Request('http://127.0.0.1/api/internal/config-apply-tasks/execute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        task: {
          taskId: 'forged-task',
          suggestionId: 'config-suggestion',
          target: 'config',
          sectionName: 'Usage Level',
          proposedValue: 'Ultra',
        },
      }),
    }));

    assert.strictEqual(response.status, 400);
    assert.match(fs.readFileSync(path.join(tempDir, 'config.md'), 'utf8'), /## Usage Level\n\nMedium/);
    const count = getDb().prepare('SELECT COUNT(*) AS count FROM config_apply_tasks')
      .get() as { count: number };
    assert.strictEqual(count.count, 0);
  });

  test('rejects enqueue payload drift transactionally', () => {
    insertConfigSuggestion();
    const before = getDb().prepare('SELECT metadata FROM feed WHERE id = ?')
      .get('config-suggestion') as { metadata: string };

    assert.throws(() => {
      enqueueConfigApplyTask(getDb(), {
        taskId: 'config-task-drift',
        suggestionId: 'config-suggestion',
        target: 'config',
        sectionName: 'Usage Level',
        proposedValue: 'Ultra',
      });
    }, /proposedValue does not match/);

    const after = getDb().prepare('SELECT metadata FROM feed WHERE id = ?')
      .get('config-suggestion') as { metadata: string };
    assert.strictEqual(after.metadata, before.metadata);
    const count = getDb().prepare('SELECT COUNT(*) AS count FROM config_apply_tasks')
      .get() as { count: number };
    assert.strictEqual(count.count, 0);
  });

  test('rolls back the task row when its feed dispatch update cannot commit', () => {
    insertConfigSuggestion();
    getDb().exec(`
      CREATE TRIGGER reject_config_dispatch
      BEFORE UPDATE OF metadata ON feed
      WHEN NEW.id = 'config-suggestion'
      BEGIN
        SELECT RAISE(ABORT, 'blocked feed update');
      END;
    `);

    assert.throws(() => {
      enqueueConfigApplyTask(getDb(), {
        taskId: 'config-task-rollback',
        suggestionId: 'config-suggestion',
        target: 'config',
        sectionName: 'Usage Level',
        proposedValue: 'High',
      });
    }, /blocked feed update/);

    const taskCount = getDb().prepare('SELECT COUNT(*) AS count FROM config_apply_tasks')
      .get() as { count: number };
    const row = getDb().prepare('SELECT metadata FROM feed WHERE id = ?')
      .get('config-suggestion') as { metadata: string };
    const metadata = JSON.parse(row.metadata) as Record<string, unknown>;
    assert.strictEqual(taskCount.count, 0);
    assert.strictEqual(metadata.suggestionStatus, 'pending');
    assert.strictEqual(metadata.taskId, undefined);
  });

  test('keeps payload columns immutable and refuses execution after suggestion drift', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'config.md'),
      '# Config\n\n## Usage Level\n\nMedium\n',
      { mode: 0o600 },
    );
    insertConfigSuggestion();
    enqueueConfigApplyTask(getDb(), {
      taskId: 'config-task-tampered',
      suggestionId: 'config-suggestion',
      target: 'config',
      sectionName: 'Usage Level',
      proposedValue: 'High',
    });
    assert.throws(() => {
      getDb().prepare(`
        UPDATE config_apply_tasks
        SET proposed_value = 'Ultra'
        WHERE task_id = 'config-task-tampered'
      `).run();
    }, /payload is immutable/);
    getDb().prepare(`
      UPDATE feed
      SET metadata = json_set(metadata, '$.proposedValue', 'Ultra')
      WHERE id = 'config-suggestion'
    `).run();

    const { POST } = await import('./route');
    const response = await POST(new Request('http://127.0.0.1/api/internal/config-apply-tasks/execute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskId: 'config-task-tampered' }),
    }));
    const body = await response.json() as Record<string, unknown>;

    assert.strictEqual(response.status, 409);
    assert.strictEqual(body.ok, false);
    assert.match(String(body.error), /no longer matches/);
    assert.match(fs.readFileSync(path.join(tempDir, 'config.md'), 'utf8'), /## Usage Level\n\nMedium/);
    const task = getDb().prepare('SELECT status FROM config_apply_tasks WHERE task_id = ?')
      .get('config-task-tampered') as { status: string };
    assert.strictEqual(task.status, 'queued');
  });

  test('reconciles a completion failure after the atomic rename without reporting failed', async () => {
    const transition = journalTransition();
    fs.writeFileSync(path.join(tempDir, 'config.md'), transition.before, { mode: 0o600 });
    insertConfigSuggestion({ id: 'config-suggestion-completion-retry' });
    enqueueConfigApplyTask(getDb(), {
      taskId: 'config-task-completion-retry',
      suggestionId: 'config-suggestion-completion-retry',
      target: 'config',
      sectionName: 'Usage Level',
      proposedValue: 'High',
    });

    let completionAttempts = 0;
    getDb().function('fail_config_completion_once', () => {
      completionAttempts += 1;
      if (completionAttempts === 1) {
        throw new Error('injected completion persistence failure');
      }
      return 0;
    });
    getDb().exec(`
      CREATE TRIGGER fail_first_config_completion
      BEFORE UPDATE OF status ON config_apply_tasks
      WHEN OLD.status = 'running' AND NEW.status = 'applied'
      BEGIN
        SELECT fail_config_completion_once();
      END;
    `);

    const { POST } = await import('./route');
    const response = await POST(new Request(
      'http://127.0.0.1/api/internal/config-apply-tasks/execute',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ taskId: 'config-task-completion-retry' }),
      },
    ));
    const body = await response.json() as Record<string, unknown>;

    assert.strictEqual(response.status, 200);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.alreadyApplied, true);
    assert.strictEqual(body.recoveredCompletion, true);
    assert.strictEqual(completionAttempts, 2);
    assert.strictEqual(
      fs.readFileSync(path.join(tempDir, 'config.md'), 'utf8'),
      transition.after,
    );
    const task = getDb().prepare(`
      SELECT status, error
      FROM config_apply_tasks
      WHERE task_id = ?
    `).get('config-task-completion-retry') as { status: string; error: string | null };
    assert.deepStrictEqual(task, { status: 'applied', error: null });
    const suggestion = getDb().prepare('SELECT metadata FROM feed WHERE id = ?')
      .get('config-suggestion-completion-retry') as { metadata: string };
    const metadata = JSON.parse(suggestion.metadata) as Record<string, unknown>;
    assert.strictEqual(metadata.configApplyStatus, 'applied');
    assert.strictEqual(metadata.suggestionStatus, 'accepted');
  });

  test('requeues an interrupted task that died after journaling but before the file write', async () => {
    const transition = journalTransition();
    fs.writeFileSync(path.join(tempDir, 'config.md'), transition.before, { mode: 0o600 });
    insertConfigSuggestion({ id: 'config-suggestion-before-write' });
    enqueueConfigApplyTask(getDb(), {
      taskId: 'config-task-before-write',
      suggestionId: 'config-suggestion-before-write',
      target: 'config',
      sectionName: 'Usage Level',
      proposedValue: 'High',
    });
    claimConfigApplyTask(getDb(), 'config-task-before-write', transition.journal);

    const recovery = reconcileRunningConfigApplyTasks(getDb(), { dataDir: tempDir });
    assert.deepStrictEqual(recovery.actions, [{
      taskId: 'config-task-before-write',
      action: 'requeued',
    }]);
    assert.ok(recovery.queuedTaskIds.includes('config-task-before-write'));
    const recovered = getDb().prepare(`
      SELECT status, pre_content_sha256, post_content_sha256
      FROM config_apply_tasks
      WHERE task_id = ?
    `).get('config-task-before-write') as {
      status: string;
      pre_content_sha256: string;
      post_content_sha256: string;
    };
    assert.strictEqual(recovered.status, 'queued');
    assert.strictEqual(recovered.pre_content_sha256, transition.journal.preContentSha256);
    assert.strictEqual(recovered.post_content_sha256, transition.journal.postContentSha256);

    const { POST } = await import('./route');
    const response = await POST(new Request(
      'http://127.0.0.1/api/internal/config-apply-tasks/execute',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ taskId: 'config-task-before-write' }),
      },
    ));
    assert.strictEqual(response.status, 200);
    assert.strictEqual(
      fs.readFileSync(path.join(tempDir, 'config.md'), 'utf8'),
      transition.after,
    );
  });

  test('completes an interrupted task whose atomic rename landed before terminal persistence', () => {
    const transition = journalTransition();
    fs.writeFileSync(path.join(tempDir, 'config.md'), transition.before, { mode: 0o600 });
    insertConfigSuggestion({ id: 'config-suggestion-after-rename' });
    enqueueConfigApplyTask(getDb(), {
      taskId: 'config-task-after-rename',
      suggestionId: 'config-suggestion-after-rename',
      target: 'config',
      sectionName: 'Usage Level',
      proposedValue: 'High',
    });
    claimConfigApplyTask(getDb(), 'config-task-after-rename', transition.journal);
    fs.writeFileSync(path.join(tempDir, 'config.md'), transition.after, { mode: 0o600 });

    const recovery = reconcileRunningConfigApplyTasks(getDb(), { dataDir: tempDir });
    assert.deepStrictEqual(recovery.actions, [{
      taskId: 'config-task-after-rename',
      action: 'completed',
    }]);
    const task = getDb().prepare(`
      SELECT status, result_json
      FROM config_apply_tasks
      WHERE task_id = ?
    `).get('config-task-after-rename') as { status: string; result_json: string };
    assert.strictEqual(task.status, 'applied');
    assert.deepStrictEqual(JSON.parse(task.result_json), transition.journal.result);
    const row = getDb().prepare('SELECT metadata FROM feed WHERE id = ?')
      .get('config-suggestion-after-rename') as { metadata: string };
    const metadata = JSON.parse(row.metadata) as Record<string, unknown>;
    assert.strictEqual(metadata.configApplyStatus, 'applied');
    assert.strictEqual(metadata.suggestionStatus, 'accepted');
  });

  test('serializes concurrent replay so one durable transition is applied once', async () => {
    const transition = journalTransition();
    fs.writeFileSync(path.join(tempDir, 'config.md'), transition.before, { mode: 0o600 });
    insertConfigSuggestion({ id: 'config-suggestion-concurrent' });
    enqueueConfigApplyTask(getDb(), {
      taskId: 'config-task-concurrent',
      suggestionId: 'config-suggestion-concurrent',
      target: 'config',
      sectionName: 'Usage Level',
      proposedValue: 'High',
    });
    const { POST } = await import('./route');
    const request = () => POST(new Request(
      'http://127.0.0.1/api/internal/config-apply-tasks/execute',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ taskId: 'config-task-concurrent' }),
      },
    ));
    const responses = await Promise.all([request(), request()]);
    assert.deepStrictEqual(responses.map((response) => response.status), [200, 200]);
    const bodies = await Promise.all(
      responses.map((response) => response.json() as Promise<Record<string, unknown>>),
    );
    assert.strictEqual(bodies.filter((body) => body.alreadyApplied === true).length, 1);
    assert.strictEqual(
      fs.readFileSync(path.join(tempDir, 'config.md'), 'utf8'),
      transition.after,
    );
    const task = getDb().prepare('SELECT status FROM config_apply_tasks WHERE task_id = ?')
      .get('config-task-concurrent') as { status: string };
    assert.strictEqual(task.status, 'applied');
  });

  test('fails closed when disk content diverged from both sides of an interrupted journal', () => {
    const transition = journalTransition();
    fs.writeFileSync(path.join(tempDir, 'config.md'), transition.before, { mode: 0o600 });
    insertConfigSuggestion({ id: 'config-suggestion-conflict' });
    enqueueConfigApplyTask(getDb(), {
      taskId: 'config-task-conflict',
      suggestionId: 'config-suggestion-conflict',
      target: 'config',
      sectionName: 'Usage Level',
      proposedValue: 'High',
    });
    claimConfigApplyTask(getDb(), 'config-task-conflict', transition.journal);
    const divergent = '# Config\n\n## Usage Level\n\nUltra\n';
    fs.writeFileSync(path.join(tempDir, 'config.md'), divergent, { mode: 0o600 });

    const recovery = reconcileRunningConfigApplyTasks(getDb(), { dataDir: tempDir });
    assert.deepStrictEqual(recovery.actions, [{
      taskId: 'config-task-conflict',
      action: 'conflict',
    }]);
    const task = getDb().prepare('SELECT status, error FROM config_apply_tasks WHERE task_id = ?')
      .get('config-task-conflict') as { status: string; error: string };
    assert.strictEqual(task.status, 'failed');
    assert.match(task.error, /changed outside its journal/);
    const row = getDb().prepare('SELECT metadata FROM feed WHERE id = ?')
      .get('config-suggestion-conflict') as { metadata: string };
    const metadata = JSON.parse(row.metadata) as Record<string, unknown>;
    assert.strictEqual(metadata.configApplyStatus, 'failed');
    assert.strictEqual(metadata.suggestionStatus, 'pending');
    assert.strictEqual(fs.readFileSync(path.join(tempDir, 'config.md'), 'utf8'), divergent);
  });
});
