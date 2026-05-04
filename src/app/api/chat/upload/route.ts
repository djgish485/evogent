import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import {
  buildChatAttachmentRecord,
  CHAT_ATTACHMENT_ZIP_MAX_BYTES,
  getChatAttachmentMaxBytes,
  getChatAttachmentPreviewUrl,
  getChatAttachmentsDir,
  inferChatAttachmentContentType,
  normalizeChatAttachmentFileName,
  resolveChatAttachmentExtension,
} from '@/lib/chat-attachments';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const CHAT_ATTACHMENT_UPLOAD_ZIP_MAX_BYTES = CHAT_ATTACHMENT_ZIP_MAX_BYTES;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function resolveUploadedFile(formData: FormData): File | null {
  const direct = formData.get('file');
  if (direct instanceof File) {
    return direct;
  }

  for (const value of formData.values()) {
    if (value instanceof File) {
      return value;
    }
  }

  return null;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const requestedFileName = searchParams.get('file');
  if (!requestedFileName) {
    return jsonError('file query parameter is required', 400);
  }

  const fileName = normalizeChatAttachmentFileName(requestedFileName);
  if (!fileName) {
    return jsonError('Invalid attachment file name', 400);
  }

  const filePath = path.resolve(getChatAttachmentsDir(), fileName);
  const contentType = inferChatAttachmentContentType(fileName);

  try {
    const buffer = await fs.promises.readFile(filePath);
    return new NextResponse(buffer, {
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(buffer.byteLength),
        'Cache-Control': 'private, max-age=31536000, immutable',
        'Content-Disposition': `inline; filename="${fileName.replace(/"/g, '')}"`,
      },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return jsonError('Attachment not found', 404);
    }
    return jsonError('Failed to read attachment', 500);
  }
}

export async function POST(request: Request) {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return jsonError('Invalid multipart form data', 400);
  }

  const file = resolveUploadedFile(formData);
  if (!file) {
    return jsonError('A file upload is required', 400);
  }

  if (file.size <= 0) {
    return jsonError('Uploaded file is empty', 400);
  }

  const extension = resolveChatAttachmentExtension(file.name, file.type);
  if (!extension) {
    return jsonError('Unsupported file type', 415);
  }

  const maxBytes = getChatAttachmentMaxBytes(file.name, file.type);
  if (file.size > maxBytes) {
    const maxMegabytes = Math.round(maxBytes / (1024 * 1024));
    return jsonError(`File exceeds ${maxMegabytes}MB limit`, 413);
  }

  const uploadDir = getChatAttachmentsDir();
  // TODO: add a cleanup job for old chat attachments so this directory does not grow indefinitely.
  await fs.promises.mkdir(uploadDir, { recursive: true });

  const fileName = `attachment-${randomUUID()}.${extension}`;
  const filePath = path.resolve(uploadDir, fileName);

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    await fs.promises.writeFile(filePath, buffer);
  } catch {
    return jsonError('Failed to save uploaded file', 500);
  }

  const attachment = buildChatAttachmentRecord({
    filePath,
    fileName,
    originalName: file.name,
    contentType: file.type,
    size: file.size,
  });

  if (!attachment) {
    return jsonError('Failed to build attachment metadata', 500);
  }

  return NextResponse.json({
    ...attachment,
    previewUrl: getChatAttachmentPreviewUrl(fileName),
  }, { status: 201 });
}
