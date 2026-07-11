import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { inferAnticipationFromTaskLog, extractAnticipationTopics } from './brain-orchestrator.js';

function writeLog(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-antlog-'));
  const file = path.join(dir, 'task.jsonl');
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  return file;
}

test('inferAnticipationFromTaskLog: feed-only usage is a feed_hit', () => {
  const file = writeLog([
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'curl -s http://127.0.0.1:3001/api/feed?limit=60' } }] } }),
  ]);
  assert.deepStrictEqual(inferAnticipationFromTaskLog(file, fs), { tier: 'feed_hit', sourceHint: null });
});

test('inferAnticipationFromTaskLog: browse-cache without feed is a cache_hit with source', () => {
  const file = writeLog([
    'curl http://127.0.0.1:3001/api/internal/browse-cache/items?source=youtube&limit=60',
  ]);
  assert.deepStrictEqual(inferAnticipationFromTaskLog(file, fs), { tier: 'cache_hit', sourceHint: 'youtube' });
});

test('inferAnticipationFromTaskLog: any live browse dominates as a miss', () => {
  const file = writeLog([
    'curl http://127.0.0.1:3001/api/feed?limit=60',
    'bash ~/phone-tools/phone.sh launch com.twitter.android',
  ]);
  assert.deepStrictEqual(inferAnticipationFromTaskLog(file, fs), { tier: 'miss', sourceHint: 'twitter' });
});

test('inferAnticipationFromTaskLog: no content endpoint means no event', () => {
  const file = writeLog([
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hi there!' }] } }),
  ]);
  assert.strictEqual(inferAnticipationFromTaskLog(file, fs), null);
});

test('extractAnticipationTopics strips filler and keeps the salient subject', () => {
  assert.deepStrictEqual(
    extractAnticipationTopics('Any interesting recent videos about reinforcement learning for LLM agents?'),
    ['interesting reinforcement learning llm'],
  );
  assert.deepStrictEqual(extractAnticipationTopics('ok thanks'), []);
});
