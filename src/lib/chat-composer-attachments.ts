import type { ChatAttachment } from '@/types/chat';

interface ChatComposerDataTransferLike {
  files?: ArrayLike<File> | null;
  types?: ArrayLike<string> | null;
}

export function getChatComposerTransferFiles(dataTransfer: ChatComposerDataTransferLike | null | undefined): File[] {
  return Array.from(dataTransfer?.files ?? []);
}

export function isChatComposerFileTransfer(dataTransfer: ChatComposerDataTransferLike | null | undefined): boolean {
  if (!dataTransfer) return false;
  if (getChatComposerTransferFiles(dataTransfer).length > 0) return true;
  return Array.from(dataTransfer.types ?? []).includes('Files');
}

export async function uploadChatAttachmentFiles(
  files: File[],
  fetcher: typeof fetch = fetch,
): Promise<{ uploaded: ChatAttachment[]; failures: string[] }> {
  const uploads = await Promise.allSettled(files.map(async (file) => {
    const formData = new FormData();
    formData.set('file', file);

    const response = await fetcher('/api/chat/upload', {
      method: 'POST',
      body: formData,
    });

    const payload = await response.json() as ChatAttachment & { error?: string };
    if (!response.ok) {
      throw new Error(payload.error || `Upload failed (${response.status})`);
    }

    return payload;
  }));

  return {
    uploaded: uploads
      .filter((result): result is PromiseFulfilledResult<ChatAttachment> => result.status === 'fulfilled')
      .map((result) => result.value),
    failures: uploads
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason instanceof Error ? result.reason.message : 'Upload failed'),
  };
}
