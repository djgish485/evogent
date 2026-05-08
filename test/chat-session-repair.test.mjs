import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  recoverClaudeSessionPoison,
  resolveClaudeSessionJsonlPath,
} = require('../lib/chat-session-repair.js');

const tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evogent-chat-session-repair-'));
  tempDirs.push(dir);
  return dir;
}

function assistantLine(model, text) {
  return JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      model,
      content: [{ type: 'text', text }],
    },
  });
}

function userLine(text) {
  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
    },
  });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('chat session poison recovery', () => {
  test('truncates a Claude JSONL at the last real assistant before a synthetic image API error', () => {
    const tempDir = makeTempDir();
    const jsonlPath = path.join(tempDir, 'session.jsonl');
    const cleanAssistant = assistantLine('claude-opus-4-7', 'Clean assistant reply');
    const syntheticError = assistantLine(
      '<synthetic>',
      'API Error: 400 invalid_request_error: Could not process image from URL',
    );
    fs.writeFileSync(jsonlPath, [
      cleanAssistant,
      userLine('Here is an expiring image URL: https://example.invalid/never.png'),
      syntheticError,
      JSON.stringify({ type: 'result', is_error: true, result: 'failed' }),
    ].join('\n') + '\n', 'utf8');

    const result = recoverClaudeSessionPoison({
      jsonlPath,
      now: new Date('2026-05-08T12:00:00.000Z'),
    });

    assert.equal(result.detected, true);
    assert.equal(result.recoverable, true);
    assert.equal(result.truncated, true);
    assert.equal(result.reason, 'image_url_unreachable');
    assert.equal(result.realAssistantLineIndex, 0);
    assert.equal(result.truncateLineCount, 1);
    assert.ok(result.backupPath);
    assert.ok(fs.existsSync(result.backupPath));

    const repairedLines = fs.readFileSync(jsonlPath, 'utf8').trimEnd().split('\n');
    assert.deepEqual(repairedLines, [cleanAssistant]);
    assert.match(fs.readFileSync(result.backupPath, 'utf8'), /Could not process image/);
  });

  test('does not truncate non-image synthetic API errors', () => {
    const tempDir = makeTempDir();
    const jsonlPath = path.join(tempDir, 'session.jsonl');
    const original = [
      assistantLine('claude-opus-4-7', 'Clean assistant reply'),
      assistantLine('<synthetic>', 'API Error: 400 invalid_request_error: malformed messages'),
    ].join('\n') + '\n';
    fs.writeFileSync(jsonlPath, original, 'utf8');

    const result = recoverClaudeSessionPoison({ jsonlPath });

    assert.equal(result.detected, false);
    assert.equal(result.truncated, false);
    assert.equal(result.backupPath, null);
    assert.equal(fs.readFileSync(jsonlPath, 'utf8'), original);
  });

  test('detects but does not truncate when no real assistant is inside the search bound', () => {
    const tempDir = makeTempDir();
    const jsonlPath = path.join(tempDir, 'session.jsonl');
    const lines = [
      assistantLine('claude-opus-4-7', 'Clean assistant reply'),
      ...Array.from({ length: 51 }, (_, index) => userLine(`user line ${index}`)),
      assistantLine('<synthetic>', 'API Error: 400 invalid_request_error: Image fetch failed'),
    ];
    const original = `${lines.join('\n')}\n`;
    fs.writeFileSync(jsonlPath, original, 'utf8');

    const result = recoverClaudeSessionPoison({
      jsonlPath,
      maxRealAssistantSearchLines: 50,
    });

    assert.equal(result.detected, true);
    assert.equal(result.recoverable, false);
    assert.equal(result.truncated, false);
    assert.equal(result.backupPath, null);
    assert.equal(fs.readFileSync(jsonlPath, 'utf8'), original);
  });

  test('resolves Claude project JSONL paths from working directory and session id', () => {
    const sessionId = randomUUID();
    const resolved = resolveClaudeSessionJsonlPath({
      workingDirectory: '/root/travel-plans',
      sessionId,
      homeDir: '/root',
    });

    assert.equal(resolved, path.join('/root', '.claude', 'projects', '-root-travel-plans', `${sessionId}.jsonl`));
  });
});
