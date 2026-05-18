import { randomUUID } from 'node:crypto';
import { getDb } from './client';
import { shouldDisplayAgentEventInChat } from '@/lib/chat-agent-events';
import { normalizeChatMessageText } from '@/lib/chat-text';
import { ensureChatSession, touchChatSession } from './chat-sessions';
import type {
  ChatMessage,
  ChatMessageRole,
  ChatMessageStatus,
  ChatMessageType,
} from '@/types/chat';

interface ChatMessageRow {
  id: string;
  type: string;
  role: string;
  in_reply_to: string | null;
  task_id: string | null;
  session_id: string | null;
  text: string;
  timestamp: string;
  context: string | null;
  suggestions: string | null;
  status: string | null;
  metadata: string | null;
  created_at: string;
}

interface ChatMessageSessionLookupRow {
  session_id: string | null;
  role: string;
  type: string;
}

export interface ChatMessageInsertInput {
  id?: string;
  type?: ChatMessageType;
  role: ChatMessageRole;
  inReplyTo?: string | null;
  taskId?: string | null;
  sessionId?: string | null;
  text: string;
  timestamp?: string;
  context?: string | null;
  status?: ChatMessageStatus | null;
  metadata?: Record<string, unknown> | null;
}

export interface ChatMessagePage {
  items: ChatMessage[];
  totalCount: number;
  hasMore: boolean;
  offset: number;
}

export interface PersistedChatMessage {
  message: ChatMessage;
  inserted: boolean;
}

function parseJsonRecord(input: string | null): Record<string, unknown> | null {
  if (!input) return null;
  try {
    const parsed = JSON.parse(input);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function normalizeTimestamp(input: string | null | undefined): string {
  if (!input) return new Date().toISOString();
  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) return new Date().toISOString();
  const clamped = new Date(Math.min(parsed.getTime(), Date.now()));
  return clamped.toISOString();
}

function rowToChatMessage(row: ChatMessageRow): ChatMessage {
  const type = row.type === 'agent_event' ? 'agent_event' : 'chat';
  const role = row.role === 'user' ? 'user' : 'agent';
  const text = normalizeChatMessageText(row.text, { role, type });
  const metadata = parseJsonRecord(row.metadata) ?? {};
  if (row.task_id && typeof metadata.taskId !== 'string') {
    metadata.taskId = row.task_id;
  }

  return {
    type,
    id: row.id,
    role,
    inReplyTo: row.in_reply_to,
    sessionId: row.session_id,
    text,
    timestamp: normalizeTimestamp(row.timestamp),
    context: row.context,
    status: row.status as ChatMessageStatus | null,
    metadata: Object.keys(metadata).length > 0 ? metadata : null,
    createdAt: row.created_at,
  };
}

function normalizeTaskId(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  return trimmed ? trimmed : null;
}

function isOpenClawSessionId(sessionId: string): boolean {
  return sessionId.startsWith('openclaw:');
}

function findExistingChatMessageForConflict(
  db: ReturnType<typeof getDb>,
  input: { id: string; type: ChatMessageType; role: ChatMessageRole; taskId?: string | null; inReplyTo?: string | null },
): ChatMessageRow | undefined {
  const byId = db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(input.id) as ChatMessageRow | undefined;
  if (byId) {
    return byId;
  }

  const taskId = normalizeTaskId(input.taskId);
  const inReplyTo = typeof input.inReplyTo === 'string' && input.inReplyTo.trim() ? input.inReplyTo.trim() : null;
  if (input.role !== 'agent' || input.type !== 'chat' || !taskId || !inReplyTo) {
    return undefined;
  }

  return db.prepare(`
    SELECT *
    FROM chat_messages
    WHERE role = 'agent'
      AND type = 'chat'
      AND task_id = ?
      AND in_reply_to = ?
    LIMIT 1
  `).get(taskId, inReplyTo) as ChatMessageRow | undefined;
}

export function persistChatMessage(
  input: ChatMessageInsertInput,
  options: { ignoreConflicts?: boolean } = {},
): PersistedChatMessage | null {
  const db = getDb();
  const type = input.type === 'agent_event' ? 'agent_event' : 'chat';
  const text = typeof input.text === 'string'
    ? normalizeChatMessageText(input.text, { role: input.role, type }).trim()
    : '';
  if (!text) return null;
  const idPrefix = input.role === 'agent'
    ? (type === 'agent_event' ? 'event' : 'chat')
    : 'msg';

  const id = typeof input.id === 'string' && input.id.trim()
    ? input.id.trim()
    : `${idPrefix}-${randomUUID()}`;

  const timestamp = normalizeTimestamp(input.timestamp);
  const taskId = normalizeTaskId(input.taskId);
  const replyTarget = input.inReplyTo
    ? db.prepare('SELECT session_id, role, type FROM chat_messages WHERE id = ?').get(input.inReplyTo) as ChatMessageSessionLookupRow | undefined
    : undefined;
  const sessionId = input.sessionId?.trim()
    || replyTarget?.session_id
    || 'legacy-session';
  if (!isOpenClawSessionId(sessionId)) {
    ensureChatSession(sessionId);
  }
  const stmt = db.prepare(`
    INSERT OR ${options.ignoreConflicts ? 'IGNORE' : 'ABORT'} INTO chat_messages (
      id, type, role, in_reply_to, task_id, session_id, text, timestamp, context, suggestions, status, metadata
    ) VALUES (
      @id, @type, @role, @in_reply_to, @task_id, @session_id, @text, @timestamp, @context, @suggestions, @status, @metadata
    )
  `);

  const result = stmt.run({
    id,
    type,
    role: input.role,
    in_reply_to: input.inReplyTo ?? null,
    task_id: taskId,
    session_id: sessionId,
    text,
    timestamp,
    context: input.context ?? null,
    suggestions: null,
    status: input.status ?? null,
    metadata: input.metadata ? JSON.stringify(input.metadata) : null,
  });

  if (result.changes === 0) {
    const existing = findExistingChatMessageForConflict(db, {
      id,
      type,
      role: input.role,
      taskId,
      inReplyTo: input.inReplyTo ?? null,
    });
    return existing ? { message: rowToChatMessage(existing), inserted: false } : null;
  }

  const inserted = db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(id) as ChatMessageRow | undefined;
  if (!inserted) return null;

  touchChatSession(sessionId);
  return {
    message: rowToChatMessage(inserted),
    inserted: true,
  };
}

export function insertChatMessage(
  input: ChatMessageInsertInput,
  options: { ignoreConflicts?: boolean } = {},
): ChatMessage | null {
  return persistChatMessage(input, options)?.message ?? null;
}

const legacyAgentOnlySessionFilter = `
  NOT EXISTS (
    SELECT 1
    FROM chat_sessions AS s
    WHERE s.id = m.session_id
      AND s.title GLOB 'Session *'
      AND NOT EXISTS (
        SELECT 1
        FROM chat_messages AS user_messages
        WHERE user_messages.session_id = s.id
          AND user_messages.role = 'user'
          AND user_messages.type = 'chat'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM feed AS session_feed
        WHERE session_feed.origin_session_id = s.id
      )
  )
`;

export function getChatMessagesPage(input?: {
  limit?: number;
  offset?: number;
  sessionId?: string | null;
}): ChatMessagePage {
  const db = getDb();
  const sessionId = typeof input?.sessionId === 'string' && input.sessionId.trim()
    ? input.sessionId.trim()
    : null;
  const safeLimit = Number.isFinite(input?.limit)
    ? Math.max(1, Math.min(sessionId ? 5_000 : 500, Math.floor(input!.limit!)))
    : 200;
  const safeOffset = Number.isFinite(input?.offset) ? Math.max(0, Math.floor(input!.offset!)) : 0;

  const totalRow = sessionId
    ? db.prepare(`
      SELECT COUNT(*) AS count
      FROM chat_messages AS m
      WHERE session_id = ?
        AND ${legacyAgentOnlySessionFilter}
    `).get(sessionId) as { count?: number } | undefined
    : db.prepare(`
      SELECT COUNT(*) AS count
      FROM chat_messages AS m
      WHERE ${legacyAgentOnlySessionFilter}
    `).get() as { count?: number } | undefined;
  const totalCount = Number(totalRow?.count) || 0;

  const rows = sessionId
    ? db.prepare(`
      SELECT *
      FROM (
        SELECT m.*
        FROM chat_messages AS m
        WHERE session_id = ?
          AND ${legacyAgentOnlySessionFilter}
        ORDER BY timestamp DESC, created_at DESC
        LIMIT ?
        OFFSET ?
      )
      ORDER BY timestamp ASC, created_at ASC
    `).all(sessionId, safeLimit, safeOffset) as ChatMessageRow[]
    : db.prepare(`
      SELECT *
      FROM (
        SELECT m.*
        FROM chat_messages AS m
        WHERE ${legacyAgentOnlySessionFilter}
        ORDER BY timestamp DESC, created_at DESC
        LIMIT ?
        OFFSET ?
      )
      ORDER BY timestamp ASC, created_at ASC
    `).all(safeLimit, safeOffset) as ChatMessageRow[];

  return {
    items: rows.map(rowToChatMessage),
    totalCount,
    hasMore: safeOffset + rows.length < totalCount,
    offset: safeOffset,
  };
}

export function getChatMessages(limit = 200): ChatMessage[] {
  return getChatMessagesPage({ limit }).items;
}

export function updateChatMessageStatus(id: string, status: ChatMessageStatus): boolean {
  const db = getDb();
  const result = db.prepare(`
    UPDATE chat_messages
    SET status = @status
    WHERE id = @id
  `).run({ id, status });

  return result.changes > 0;
}

export function markChatMessageDelivered(id: string): boolean {
  const db = getDb();
  const result = db.prepare(`
    UPDATE chat_messages
    SET status = 'delivered'
    WHERE id = @id
      AND status IN ('pending', 'queued', 'processing')
  `).run({ id });

  return result.changes > 0;
}

export function normalizeAgentChatOutput(
  input: unknown,
  options: {
    defaultTaskId?: string | null;
    requireTaskIdForChat?: boolean;
  } = {},
): ChatMessageInsertInput | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;

  const type = typeof raw.type === 'string' ? raw.type.trim() : '';
  if (type !== 'chat' && type !== 'agent_event') return null;

  const text = typeof raw.text === 'string'
    ? normalizeChatMessageText(raw.text, { role: 'agent', type }).trim()
    : '';
  if (!text) return null;

  const inReplyTo = typeof raw.inReplyTo === 'string' && raw.inReplyTo.trim() ? raw.inReplyTo.trim() : null;

  const idRaw = typeof raw.id === 'string' ? raw.id.trim() : '';
  const idPrefix = type === 'agent_event' ? 'event' : 'chat';
  const id = idRaw || `${idPrefix}-${randomUUID()}`;
  const metadata = raw.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata)
    ? { ...(raw.metadata as Record<string, unknown>) }
    : {};
  if (metadata.source === 'chat-output.jsonl') {
    return null;
  }
  const taskId = normalizeTaskId(
    typeof raw.taskId === 'string'
      ? raw.taskId
      : typeof metadata.taskId === 'string'
        ? metadata.taskId
        : options.defaultTaskId ?? null,
  );
  const sessionId = typeof raw.sessionId === 'string' && raw.sessionId.trim()
    ? raw.sessionId.trim()
    : typeof metadata.sessionId === 'string' && metadata.sessionId.trim()
      ? metadata.sessionId.trim()
      : null;

  if (type === 'chat' && (options.requireTaskIdForChat ?? true) && !taskId) {
    return null;
  }

  if (taskId) {
    metadata.taskId = taskId;
  }

  if (!shouldDisplayAgentEventInChat({
    type: type as ChatMessage['type'],
    inReplyTo,
    sessionId,
    metadata,
  })) {
    return null;
  }

  return {
    id,
    type,
    role: 'agent',
    text,
    inReplyTo,
    taskId,
    sessionId,
    // Always use server receive time for agent messages; model-provided timestamps are unreliable.
    timestamp: new Date().toISOString(),
    status: 'delivered',
    metadata: {
      ...metadata,
      source: 'chat-output.jsonl',
    },
  };
}
