import assert from 'node:assert';
import path from 'node:path';
import { test } from 'node:test';
import { CHAT_ATTACHMENT_ACCEPT, parseChatAttachments, resolveChatAttachmentExtension } from './chat-attachment-metadata';
import {
  buildChatAttachmentRecord,
  getChatAttachmentsDir,
} from './chat-attachments';

test('resolveChatAttachmentExtension supports expected image and document types', () => {
  assert.strictEqual(resolveChatAttachmentExtension('example.png', 'image/png'), 'png');
  assert.strictEqual(resolveChatAttachmentExtension('example.jpeg', 'image/jpeg'), 'jpeg');
  assert.strictEqual(resolveChatAttachmentExtension('example.csv', 'text/csv'), 'csv');
  assert.strictEqual(resolveChatAttachmentExtension('archive.zip', 'application/zip'), 'zip');
  assert.strictEqual(resolveChatAttachmentExtension('example.exe', 'application/octet-stream'), null);
  assert.match(CHAT_ATTACHMENT_ACCEPT, /\.pdf/);
  assert.match(CHAT_ATTACHMENT_ACCEPT, /\.zip/);
});

test('buildChatAttachmentRecord normalizes valid attachments and rejects unsafe paths', () => {
  const uploadDir = getChatAttachmentsDir();
  const valid = buildChatAttachmentRecord({
    filePath: path.join(uploadDir, 'attachment-abc123.png'),
    originalName: 'photo.png',
    contentType: 'image/png',
    size: 128,
  });

  assert.ok(valid);
  assert.strictEqual(valid?.fileName, 'attachment-abc123.png');
  assert.strictEqual(valid?.kind, 'image');
  assert.strictEqual(valid?.previewUrl, '/api/chat/upload?file=attachment-abc123.png');

  const invalid = buildChatAttachmentRecord({
    filePath: '/tmp/not-allowed/attachment-abc123.png',
    originalName: 'photo.png',
    contentType: 'image/png',
    size: 128,
  });

  assert.strictEqual(invalid, null);
});

test('parseChatAttachments ignores malformed entries', () => {
  const uploadDir = getChatAttachmentsDir();
  const attachments = parseChatAttachments([
    {
      filePath: path.join(uploadDir, 'attachment-abc123.png'),
      fileName: 'attachment-abc123.png',
      originalName: 'photo.png',
      contentType: 'image/png',
      size: 256,
    },
    {
      filePath: '',
      fileName: 'escape.txt',
    },
    null,
  ]);

  assert.strictEqual(attachments.length, 1);
  assert.strictEqual(attachments[0]?.originalName, 'photo.png');
});
