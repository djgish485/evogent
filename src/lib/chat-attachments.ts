import path from 'node:path';
import type { ChatAttachment, ChatAttachmentKind } from '@/types/chat';
import { getDataPath } from '@/lib/data-dir';
import {
  CHAT_ATTACHMENT_ACCEPT,
  CHAT_ATTACHMENT_MAX_BYTES,
  CHAT_ATTACHMENT_ZIP_MAX_BYTES,
  getChatAttachmentMaxBytes,
  inferChatAttachmentContentType,
  isImageChatAttachment,
  parseChatAttachments as parseChatAttachmentsUnsafe,
  resolveChatAttachmentExtension,
} from '@/lib/chat-attachment-metadata';

export {
  CHAT_ATTACHMENT_ACCEPT,
  CHAT_ATTACHMENT_MAX_BYTES,
  CHAT_ATTACHMENT_ZIP_MAX_BYTES,
  getChatAttachmentMaxBytes,
  inferChatAttachmentContentType,
  isImageChatAttachment,
  resolveChatAttachmentExtension,
};

function isWithinAttachmentDir(filePath: string): boolean {
  const relativePath = path.relative(getChatAttachmentsDir(), filePath);
  return Boolean(relativePath)
    && !relativePath.startsWith('..')
    && !path.isAbsolute(relativePath);
}

export function getChatAttachmentsDir(): string {
  return getDataPath('chat-attachments');
}

export function getChatAttachmentPreviewUrl(fileName: string): string {
  return `/api/chat/upload?file=${encodeURIComponent(fileName)}`;
}

export function resolveChatAttachmentKind(
  fileName: string,
  contentType?: string | null,
): ChatAttachmentKind {
  return isImageChatAttachment(fileName, contentType) ? 'image' : 'document';
}

export function normalizeChatAttachmentFileName(candidate: string): string | null {
  if (typeof candidate !== 'string') return null;
  const basename = path.basename(candidate.trim());
  if (!basename || basename !== candidate.trim()) return null;
  const extension = resolveChatAttachmentExtension(basename);
  return extension ? basename : null;
}

export function buildChatAttachmentRecord(input: {
  filePath: string;
  fileName?: string | null;
  originalName?: string | null;
  contentType?: string | null;
  size?: number | null;
}): ChatAttachment | null {
  if (typeof input.filePath !== 'string' || !input.filePath.trim()) {
    return null;
  }

  const absolutePath = path.resolve(input.filePath.trim());
  if (!isWithinAttachmentDir(absolutePath)) {
    return null;
  }

  const candidateFileName = normalizeChatAttachmentFileName(
    typeof input.fileName === 'string' && input.fileName.trim()
      ? input.fileName.trim()
      : path.basename(absolutePath),
  );
  if (!candidateFileName) {
    return null;
  }

  const extension = resolveChatAttachmentExtension(candidateFileName, input.contentType);
  if (!extension) {
    return null;
  }

  const size = Number.isFinite(input.size) ? Math.max(0, Number(input.size)) : 0;
  const contentType = inferChatAttachmentContentType(candidateFileName, input.contentType);
  const originalName = typeof input.originalName === 'string' && input.originalName.trim()
    ? path.basename(input.originalName.trim())
    : candidateFileName;

  return {
    filePath: absolutePath,
    fileName: candidateFileName,
    originalName,
    previewUrl: getChatAttachmentPreviewUrl(candidateFileName),
    contentType,
    size,
    kind: resolveChatAttachmentKind(candidateFileName, contentType),
  };
}

export function parseChatAttachments(input: unknown): ChatAttachment[] {
  return parseChatAttachmentsUnsafe(input)
    .map((attachment) => buildChatAttachmentRecord(attachment))
    .filter((attachment): attachment is ChatAttachment => attachment !== null);
}
