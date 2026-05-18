import { type ConversationSessionType } from './conversation';

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

export interface OpenClawSession {
  key: string;
  sessionId: string;
  label: string;
  sessionType: ConversationSessionType;
  preview: string;
  updatedAt: string;
  messageCount: number | null;
  hasUserActivity?: boolean;
  firstUserMessageText?: string;
  status: string | null;
  agentId: string | null;
}

export interface OpenClawMessageEvent {
  type: 'openclaw_session_message' | 'openclaw_session_streaming' | 'openclaw_session_done';
  sessionKey: string;
  sessionId: string;
  message?: ChatMessage;
  text?: string;
  state?: string;
  error?: string | null;
  ts: string;
}
