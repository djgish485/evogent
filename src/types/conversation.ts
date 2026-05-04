export type ConversationSessionType = 'curator' | null;

export interface ConversationSessionPreviewMessage {
  id: string;
  type: 'chat' | 'agent_event';
  role: 'user' | 'agent';
  text: string;
  timestamp: string;
  metadata?: Record<string, unknown> | null;
}

export interface ConversationSessionSummary {
  sessionId: string;
  provider: 'claude' | 'codex';
  claudeReasoningEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  codexReasoningEffort: 'low' | 'medium' | 'high' | 'xhigh';
  codexFastMode: boolean;
  latestContextTokens: number | null;
  latestContextWindow: number | null;
  latestContextModel: string | null;
  latestContextUpdatedAt: string | null;
  title: string;
  color: string | null;
  sessionType: ConversationSessionType;
  workingDirectory: string;
  lastMaterialActivityAt: string;
  conversationCount: number;
  messageCount: number;
  feedItemCount: number;
  previewText: string | null;
  previewMessages: ConversationSessionPreviewMessage[];
  lastActor: 'user' | 'agent' | null;
  contextKind: 'global' | 'post';
  contextRefId: string | null;
}

export interface ConversationSessionPage {
  sessions: ConversationSessionSummary[];
  count: number;
  totalCount: number;
  hasMore: boolean;
  nextOffset: number | null;
}
