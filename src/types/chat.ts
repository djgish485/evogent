export type ChatMessageRole = 'user' | 'agent';
export type ChatMessageType = 'chat' | 'agent_event';

export type ChatMessageStatus = 'pending' | 'queued' | 'processing' | 'failed' | 'cancelled' | 'delivered';

export type ConfigSuggestionDecision = 'accepted' | 'rejected';

export type ChatAttachmentKind = 'image' | 'document';

export interface ChatAttachment {
  filePath: string;
  fileName: string;
  originalName: string;
  previewUrl: string;
  contentType: string;
  size: number;
  kind: ChatAttachmentKind;
}

export interface ChatMessage {
  type: ChatMessageType;
  id: string;
  role: ChatMessageRole;
  inReplyTo: string | null;
  sessionId?: string | null;
  text: string;
  timestamp: string;
  context: string | null;
  status?: ChatMessageStatus | null;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
}
