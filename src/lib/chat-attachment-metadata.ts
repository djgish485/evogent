import type { ChatAttachment, ChatAttachmentKind } from '@/types/chat';

export const CHAT_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const CHAT_ATTACHMENT_ZIP_MAX_BYTES = 100 * 1024 * 1024;
export const CHAT_ATTACHMENT_ACCEPT = '.png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.md,.json,.csv,.zip';

const CHAT_ATTACHMENT_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'pdf',
  'txt',
  'md',
  'json',
  'csv',
  'zip',
]);

const EXTENSION_TO_CONTENT_TYPE: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  json: 'application/json; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  zip: 'application/zip',
};

const CONTENT_TYPE_TO_EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'application/json': 'json',
  'text/csv': 'csv',
  'application/vnd.ms-excel': 'csv',
  'application/zip': 'zip',
  'application/x-zip-compressed': 'zip',
};

function normalizeExtension(candidate: string | null | undefined): string | null {
  if (typeof candidate !== 'string') return null;
  const trimmed = candidate.trim().toLowerCase().replace(/^\./, '');
  return trimmed && CHAT_ATTACHMENT_EXTENSIONS.has(trimmed) ? trimmed : null;
}

function normalizeContentType(candidate: string | null | undefined): string | null {
  if (typeof candidate !== 'string') return null;
  const trimmed = candidate.trim().toLowerCase();
  if (!trimmed) return null;
  return trimmed.split(';')[0]?.trim() || null;
}

function basename(input: string): string {
  const normalized = input.replace(/\\/g, '/');
  return normalized.split('/').pop() || '';
}

export function resolveChatAttachmentExtension(
  fileName: string,
  contentType?: string | null,
): string | null {
  const normalizedFileName = basename(fileName).trim();
  const dottedExtension = normalizedFileName.includes('.')
    ? normalizedFileName.slice(normalizedFileName.lastIndexOf('.') + 1)
    : '';
  const byName = normalizeExtension(dottedExtension);
  if (byName) return byName;

  const normalizedContentType = normalizeContentType(contentType);
  if (!normalizedContentType) return null;
  return normalizeExtension(CONTENT_TYPE_TO_EXTENSION[normalizedContentType] ?? null);
}

export function inferChatAttachmentContentType(
  fileName: string,
  contentType?: string | null,
): string {
  const normalizedContentType = normalizeContentType(contentType);
  if (normalizedContentType && CONTENT_TYPE_TO_EXTENSION[normalizedContentType]) {
    const resolvedExtension = resolveChatAttachmentExtension(fileName, normalizedContentType);
    if (resolvedExtension) {
      return EXTENSION_TO_CONTENT_TYPE[resolvedExtension];
    }
  }

  const extension = resolveChatAttachmentExtension(fileName, contentType);
  return extension ? EXTENSION_TO_CONTENT_TYPE[extension] : 'application/octet-stream';
}

export function isImageChatAttachment(
  fileName: string,
  contentType?: string | null,
): boolean {
  const extension = resolveChatAttachmentExtension(fileName, contentType);
  return extension === 'png'
    || extension === 'jpg'
    || extension === 'jpeg'
    || extension === 'gif'
    || extension === 'webp';
}

export function resolveChatAttachmentKind(
  fileName: string,
  contentType?: string | null,
): ChatAttachmentKind {
  return isImageChatAttachment(fileName, contentType) ? 'image' : 'document';
}

export function getChatAttachmentMaxBytes(
  fileName: string,
  contentType?: string | null,
): number {
  const extension = resolveChatAttachmentExtension(fileName, contentType);
  return extension === 'zip' ? CHAT_ATTACHMENT_ZIP_MAX_BYTES : CHAT_ATTACHMENT_MAX_BYTES;
}

export function parseChatAttachments(input: unknown): ChatAttachment[] {
  if (!Array.isArray(input)) return [];

  return input
    .map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return null;
      }

      const raw = entry as Record<string, unknown>;
      const filePath = typeof raw.filePath === 'string' ? raw.filePath.trim() : '';
      const fileName = typeof raw.fileName === 'string' ? basename(raw.fileName.trim()) : basename(filePath);
      const originalName = typeof raw.originalName === 'string' && raw.originalName.trim()
        ? basename(raw.originalName.trim())
        : fileName;
      const extension = resolveChatAttachmentExtension(fileName, typeof raw.contentType === 'string' ? raw.contentType : null);
      if (!filePath || !fileName || !extension) {
        return null;
      }

      const contentType = inferChatAttachmentContentType(fileName, typeof raw.contentType === 'string' ? raw.contentType : null);
      const size = typeof raw.size === 'number' && Number.isFinite(raw.size) ? Math.max(0, raw.size) : 0;
      return {
        filePath,
        fileName,
        originalName,
        previewUrl: typeof raw.previewUrl === 'string' && raw.previewUrl.trim() ? raw.previewUrl.trim() : '',
        contentType,
        size,
        kind: resolveChatAttachmentKind(fileName, contentType),
      } satisfies ChatAttachment;
    })
    .filter((entry): entry is ChatAttachment => entry !== null);
}
