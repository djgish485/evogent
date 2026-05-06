import { randomUUID } from 'node:crypto';
import { getDb } from './client';
import { shouldDisplayAgentEventInChat } from '@/lib/chat-agent-events';
import {
  DEFAULT_GENERAL_AGENT_SESSION_TITLE,
  generateSessionTitle as buildSessionTitle,
} from '@/lib/chat-session-title';
import { normalizeChatMessageText } from '@/lib/chat-text';
import { getDataPath } from '@/lib/data-dir';
import type {
  ConversationSessionType,
  ConversationSessionPage,
  ConversationSessionPreviewMessage,
  ConversationSessionSummary,
} from '@/types/conversation';
import {
  normalizeClaudeReasoningEffort,
  normalizeCodexReasoningEffort,
  readBrainConfig,
} from '../../../lib/brain-config.js';

interface ChatSessionRow {
  id: string;
  provider: string | null;
  provider_session_id: string | null;
  claude_session_id: string;
  session_type: string | null;
  claude_reasoning_effort: string | null;
  codex_reasoning_effort: string | null;
  codex_fast_mode: number | null;
  latest_context_tokens: number | null;
  latest_context_window: number | null;
  latest_context_model: string | null;
  latest_context_updated_at: string | null;
  title: string | null;
  color: string | null;
  working_directory: string | null;
  created_at: string;
  updated_at: string;
}

interface ConversationSessionAggregateRow {
  session_id: string;
  provider: string | null;
  session_type: string | null;
  claude_reasoning_effort: string | null;
  codex_reasoning_effort: string | null;
  codex_fast_mode: number | null;
  latest_context_tokens: number | null;
  latest_context_window: number | null;
  latest_context_model: string | null;
  latest_context_updated_at: string | null;
  title: string | null;
  color: string | null;
  working_directory: string | null;
  created_at: string | null;
  updated_at: string | null;
  last_message_timestamp: string | null;
  message_count: number;
  user_message_count: number;
  feed_item_count: number;
  creation_order_index: number;
}

interface ConversationSessionPreviewRow {
  session_id?: string;
  id: string;
  type: string;
  role: string;
  text: string;
  timestamp: string;
  metadata: string | null;
}

const SESSION_COLOR_KEYS = [
  'blue',
  'purple',
  'teal',
  'amber',
  'rose',
  'green',
  'indigo',
  'pink',
] as const;

type SessionColorKey = (typeof SESSION_COLOR_KEYS)[number];
export type BrainProviderName = 'claude' | 'codex';
export type CodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';
export type ClaudeReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const POST_CONTEXT_SEPARATOR = '\n\nContext — discussing this post:';

function isUuid(value: string | null | undefined): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function normalizeIsoTimestamp(input: string | null | undefined): string {
  if (!input) return new Date().toISOString();
  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) return new Date().toISOString();
  return parsed.toISOString();
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

function sanitizeSessionTitle(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  return trimmed ? trimmed : null;
}

function sanitizeSessionColor(input: string | null | undefined): SessionColorKey | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim().toLowerCase();
  return SESSION_COLOR_KEYS.includes(trimmed as SessionColorKey)
    ? trimmed as SessionColorKey
    : null;
}

function sanitizeWorkingDirectory(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  return trimmed ? trimmed : null;
}

function sanitizeSessionType(input: string | null | undefined): ConversationSessionType {
  if (typeof input !== 'string') return null;
  return input.trim().toLowerCase() === 'curator' ? 'curator' : null;
}

function normalizeBooleanFlag(input: unknown): boolean {
  return input === true || input === 1;
}

function normalizeBrainProvider(value: string | null | undefined): BrainProviderName {
  const normalized = typeof value === 'string'
    ? value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '')
    : '';
  return normalized === 'codex' || normalized === 'codexcli' ? 'codex' : 'claude';
}

function getDefaultBrainProvider(): BrainProviderName {
  return normalizeBrainProvider(readBrainConfig(getDataPath('config.md')).provider);
}

function getDefaultCodexReasoningEffort(): CodexReasoningEffort {
  return normalizeCodexReasoningEffort(
    readBrainConfig(getDataPath('config.md')).codexReasoningEffort,
  ) as CodexReasoningEffort;
}

function getDefaultClaudeReasoningEffort(): ClaudeReasoningEffort {
  return normalizeClaudeReasoningEffort(
    readBrainConfig(getDataPath('config.md')).claudeReasoningEffort,
  ) as ClaudeReasoningEffort;
}

export interface ChatSessionRecord {
  id: string;
  provider: BrainProviderName;
  providerSessionId: string;
  claudeSessionId: string;
  claudeReasoningEffort: ClaudeReasoningEffort;
  codexReasoningEffort: CodexReasoningEffort;
  codexFastMode: boolean;
  latestContextTokens: number | null;
  latestContextWindow: number | null;
  latestContextModel: string | null;
  latestContextUpdatedAt: string | null;
  title: string;
  color: SessionColorKey | null;
  sessionType: ConversationSessionType;
  workingDirectory: string;
  createdAt: string;
  updatedAt: string;
}

export function generateSessionTitle(creationOrderIndex: number): string {
  return buildSessionTitle(creationOrderIndex);
}

function normalizeConversationPreviewText(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;
  const normalized = input
    .split(POST_CONTEXT_SEPARATOR)[0]
    ?.replace(/^Chat:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized ? normalized : null;
}

function sanitizeConversationPreviewText(input: string | null | undefined): string | null {
  const normalized = normalizeConversationPreviewText(input);
  if (!normalized) return null;
  return normalized.length > 180 ? `${normalized.slice(0, 177).trimEnd()}...` : normalized;
}

function rowToConversationPreviewMessage(row: ConversationSessionPreviewRow): ConversationSessionPreviewMessage | null {
  const type = row.type === 'agent_event' ? 'agent_event' : 'chat';
  const role = row.role === 'user' ? 'user' : 'agent';
  const metadata = parseJsonRecord(row.metadata);
  const text = normalizeChatMessageText(row.text, { role, type });

  if (!shouldDisplayAgentEventInChat({
    type,
    inReplyTo: null,
    sessionId: null,
    metadata,
  })) {
    return null;
  }

  return {
    id: row.id,
    type,
    role,
    text,
    timestamp: normalizeIsoTimestamp(row.timestamp),
    metadata,
  };
}

function readConversationContext(rows: ConversationSessionPreviewRow[]): { contextKind: 'global' | 'post'; contextRefId: string | null } {
  for (const row of rows) {
    const metadata = parseJsonRecord(row.metadata);
    const contextRefId = typeof metadata?.contextRefId === 'string' && metadata.contextRefId.trim()
      ? metadata.contextRefId.trim()
      : null;
    if (contextRefId) {
      return {
        contextKind: 'post',
        contextRefId,
      };
    }
  }

  return {
    contextKind: 'global',
    contextRefId: null,
  };
}

function buildSessionPreview(messages: ConversationSessionPreviewMessage[]): {
  previewMessages: ConversationSessionPreviewMessage[];
  previewText: string | null;
  lastActor: 'user' | 'agent' | null;
} {
  const displayable = messages;
  const previewMessages = displayable.slice(0, 3).reverse();
  const latestAgentChatMessage = displayable.find((message) => message.role === 'agent' && message.type === 'chat') ?? null;
  const latestMessage = latestAgentChatMessage ?? displayable[0] ?? null;

  return {
    previewMessages,
    previewText: sanitizeConversationPreviewText(latestMessage?.text),
    lastActor: latestMessage?.role ?? null,
  };
}

function rowToChatSession(row: ChatSessionRow): ChatSessionRecord {
  const provider = normalizeBrainProvider(row.provider);
  const providerSessionId = isUuid(row.provider_session_id?.trim())
    ? row.provider_session_id!.trim()
    : isUuid(row.claude_session_id?.trim())
      ? row.claude_session_id.trim()
      : row.id;

  return {
    id: row.id,
    provider,
    providerSessionId,
    claudeSessionId: providerSessionId,
    claudeReasoningEffort: normalizeClaudeReasoningEffort(
      row.claude_reasoning_effort ?? getDefaultClaudeReasoningEffort(),
    ) as ClaudeReasoningEffort,
    codexReasoningEffort: normalizeCodexReasoningEffort(row.codex_reasoning_effort) as CodexReasoningEffort,
    codexFastMode: normalizeBooleanFlag(row.codex_fast_mode),
    latestContextTokens: Number.isFinite(row.latest_context_tokens) ? Number(row.latest_context_tokens) : null,
    latestContextWindow: Number.isFinite(row.latest_context_window) ? Number(row.latest_context_window) : null,
    latestContextModel: typeof row.latest_context_model === 'string' && row.latest_context_model.trim()
      ? row.latest_context_model.trim()
      : null,
    latestContextUpdatedAt: typeof row.latest_context_updated_at === 'string' && row.latest_context_updated_at.trim()
      ? normalizeIsoTimestamp(row.latest_context_updated_at)
      : null,
    title: sanitizeSessionTitle(row.title) ?? DEFAULT_GENERAL_AGENT_SESSION_TITLE,
    color: sanitizeSessionColor(row.color),
    sessionType: sanitizeSessionType(row.session_type),
    workingDirectory: sanitizeWorkingDirectory(row.working_directory) ?? process.cwd(),
    createdAt: normalizeIsoTimestamp(row.created_at),
    updatedAt: normalizeIsoTimestamp(row.updated_at),
  };
}

export function getChatSession(sessionId: string): ChatSessionRecord | null {
  const trimmedSessionId = sessionId.trim();
  if (!trimmedSessionId) return null;

  const row = getDb().prepare(`
    SELECT
      s.id,
      s.provider,
      s.provider_session_id,
      s.claude_session_id,
      s.session_type,
      bs.claude_reasoning_effort,
      bs.codex_reasoning_effort,
      bs.codex_fast_mode,
      bs.latest_context_tokens,
      bs.latest_context_window,
      bs.latest_context_model,
      bs.latest_context_updated_at,
      s.title,
      s.color,
      s.working_directory,
      s.created_at,
      s.updated_at
    FROM chat_sessions AS s
    LEFT JOIN chat_session_brain_settings AS bs
      ON bs.session_id = s.id
    WHERE id = ?
  `).get(trimmedSessionId) as ChatSessionRow | undefined;

  return row ? rowToChatSession(row) : null;
}

export function createChatSession(input?: {
  id?: string;
  provider?: BrainProviderName | string | null;
  providerSessionId?: string | null;
  claudeSessionId?: string | null;
  claudeReasoningEffort?: ClaudeReasoningEffort | string | null;
  codexReasoningEffort?: CodexReasoningEffort | string | null;
  codexFastMode?: boolean | null;
  title?: string | null;
  color?: string | null;
  sessionType?: ConversationSessionType | string | null;
  workingDirectory?: string | null;
}): ChatSessionRecord {
  const id = isUuid(input?.id?.trim()) ? input?.id?.trim() : randomUUID();
  const provider = normalizeBrainProvider(input?.provider ?? getDefaultBrainProvider());
  const providerSessionId = isUuid(input?.providerSessionId?.trim())
    ? input?.providerSessionId?.trim()
    : isUuid(input?.claudeSessionId?.trim())
      ? input?.claudeSessionId?.trim()
      : id;
  const claudeSessionId = provider === 'claude'
    ? providerSessionId
    : '';
  const claudeReasoningEffort = normalizeClaudeReasoningEffort(
    input?.claudeReasoningEffort ?? getDefaultClaudeReasoningEffort(),
  ) as ClaudeReasoningEffort;
  const codexReasoningEffort = normalizeCodexReasoningEffort(
    input?.codexReasoningEffort ?? getDefaultCodexReasoningEffort(),
  ) as CodexReasoningEffort;
  const codexFastMode = input?.codexFastMode === true;
  const title = sanitizeSessionTitle(input?.title) ?? generateSessionTitle(countChatSessions());
  const color = sanitizeSessionColor(input?.color);
  const sessionType = sanitizeSessionType(input?.sessionType);
  const workingDirectory = sanitizeWorkingDirectory(input?.workingDirectory);

  const db = getDb();

  db.prepare(`
    INSERT OR IGNORE INTO chat_sessions (
      id,
      provider,
      provider_session_id,
      claude_session_id,
      title,
      color,
      session_type,
      working_directory
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, provider, providerSessionId, claudeSessionId, title, color, sessionType, workingDirectory);

  db.prepare(`
    INSERT INTO chat_session_brain_settings (session_id, claude_reasoning_effort, codex_reasoning_effort, codex_fast_mode)
    SELECT ?, ?, ?, ?
    WHERE EXISTS (
      SELECT 1
      FROM chat_sessions
      WHERE id = ?
    )
    ON CONFLICT(session_id) DO UPDATE SET
      claude_reasoning_effort = excluded.claude_reasoning_effort,
      codex_reasoning_effort = excluded.codex_reasoning_effort,
      codex_fast_mode = excluded.codex_fast_mode,
      updated_at = datetime('now')
  `).run(id, claudeReasoningEffort, codexReasoningEffort, codexFastMode ? 1 : 0, id);

  const existing = getChatSession(id);
  if (!existing) {
    throw new Error(`Failed to create chat session ${id}`);
  }

  return existing;
}

export function ensureChatSession(sessionId: string): ChatSessionRecord {
  const existing = getChatSession(sessionId);
  if (existing) return existing;
  return createChatSession({ id: sessionId });
}

export function updateChatSession(input: {
  sessionId: string;
  title?: string | null;
  color?: string | null;
  sessionType?: ConversationSessionType | string | null;
  workingDirectory?: string | null;
  claudeReasoningEffort?: ClaudeReasoningEffort | string | null;
  codexReasoningEffort?: CodexReasoningEffort | string | null;
  codexFastMode?: boolean | null;
  updateTitle?: boolean;
  updateColor?: boolean;
  updateSessionType?: boolean;
  updateWorkingDirectory?: boolean;
  updateClaudeReasoningEffort?: boolean;
  updateCodexReasoningEffort?: boolean;
  updateCodexFastMode?: boolean;
}): ChatSessionRecord | null {
  const trimmedSessionId = input.sessionId.trim();
  if (!trimmedSessionId) return null;
  if (!getChatSession(trimmedSessionId)) return null;

  const title = sanitizeSessionTitle(input.title);
  const color = sanitizeSessionColor(input.color);
  const sessionType = sanitizeSessionType(input.sessionType);
  const workingDirectory = sanitizeWorkingDirectory(input.workingDirectory);
  const shouldUpdateTitle = input.updateTitle ?? false;
  const shouldUpdateColor = input.updateColor ?? false;
  const shouldUpdateSessionType = input.updateSessionType ?? false;
  const shouldUpdateWorkingDirectory = input.updateWorkingDirectory ?? false;
  const shouldUpdateClaudeReasoningEffort = input.updateClaudeReasoningEffort ?? false;
  const shouldUpdateCodexReasoningEffort = input.updateCodexReasoningEffort ?? false;
  const shouldUpdateCodexFastMode = input.updateCodexFastMode ?? false;

  const updateSession = getDb().transaction(() => {
    if (shouldUpdateTitle || shouldUpdateColor || shouldUpdateSessionType || shouldUpdateWorkingDirectory) {
      getDb().prepare(`
        UPDATE chat_sessions
        SET
          title = CASE WHEN ? THEN ? ELSE title END,
          color = CASE WHEN ? THEN ? ELSE color END,
          session_type = CASE WHEN ? THEN ? ELSE session_type END,
          working_directory = CASE WHEN ? THEN ? ELSE working_directory END,
          updated_at = datetime('now')
        WHERE id = ?
      `).run(
        shouldUpdateTitle ? 1 : 0,
        title,
        shouldUpdateColor ? 1 : 0,
        color,
        shouldUpdateSessionType ? 1 : 0,
        sessionType,
        shouldUpdateWorkingDirectory ? 1 : 0,
        workingDirectory,
        trimmedSessionId,
      );
    }

    if (shouldUpdateClaudeReasoningEffort) {
      const claudeReasoningEffort = normalizeClaudeReasoningEffort(
        input.claudeReasoningEffort ?? getDefaultClaudeReasoningEffort(),
      ) as ClaudeReasoningEffort;

      getDb().prepare(`
        INSERT INTO chat_session_brain_settings (session_id, claude_reasoning_effort)
        SELECT ?, ?
        WHERE EXISTS (
          SELECT 1
          FROM chat_sessions
          WHERE id = ?
        )
        ON CONFLICT(session_id) DO UPDATE SET
          claude_reasoning_effort = excluded.claude_reasoning_effort,
          updated_at = datetime('now')
      `).run(trimmedSessionId, claudeReasoningEffort, trimmedSessionId);
    }

    if (shouldUpdateCodexReasoningEffort) {
      const codexReasoningEffort = normalizeCodexReasoningEffort(
        input.codexReasoningEffort ?? getDefaultCodexReasoningEffort(),
      ) as CodexReasoningEffort;

      getDb().prepare(`
        INSERT INTO chat_session_brain_settings (session_id, codex_reasoning_effort)
        SELECT ?, ?
        WHERE EXISTS (
          SELECT 1
          FROM chat_sessions
          WHERE id = ?
        )
        ON CONFLICT(session_id) DO UPDATE SET
          codex_reasoning_effort = excluded.codex_reasoning_effort,
          updated_at = datetime('now')
      `).run(trimmedSessionId, codexReasoningEffort, trimmedSessionId);
    }

    if (shouldUpdateCodexFastMode) {
      getDb().prepare(`
        INSERT INTO chat_session_brain_settings (session_id, codex_fast_mode)
        SELECT ?, ?
        WHERE EXISTS (
          SELECT 1
          FROM chat_sessions
          WHERE id = ?
        )
        ON CONFLICT(session_id) DO UPDATE SET
          codex_fast_mode = excluded.codex_fast_mode,
          updated_at = datetime('now')
      `).run(trimmedSessionId, input.codexFastMode === true ? 1 : 0, trimmedSessionId);
    }

    if ((shouldUpdateClaudeReasoningEffort || shouldUpdateCodexReasoningEffort || shouldUpdateCodexFastMode) && !shouldUpdateTitle && !shouldUpdateColor && !shouldUpdateWorkingDirectory) {
      touchChatSession(trimmedSessionId);
    }

    return getChatSession(trimmedSessionId);
  });

  return updateSession();
}

export function updateChatSessionBrainSettings(input: {
  sessionId: string;
  claudeReasoningEffort?: ClaudeReasoningEffort | string | null;
  codexReasoningEffort?: CodexReasoningEffort | string | null;
  codexFastMode?: boolean | null;
}): ChatSessionRecord | null {
  return updateChatSession({
    sessionId: input.sessionId,
    claudeReasoningEffort: input.claudeReasoningEffort,
    codexReasoningEffort: input.codexReasoningEffort,
    codexFastMode: input.codexFastMode,
    updateClaudeReasoningEffort: Object.prototype.hasOwnProperty.call(input, 'claudeReasoningEffort'),
    updateCodexReasoningEffort: Object.prototype.hasOwnProperty.call(input, 'codexReasoningEffort'),
    updateCodexFastMode: Object.prototype.hasOwnProperty.call(input, 'codexFastMode'),
  });
}

export function updateChatSessionContextMetrics(input: {
  sessionId: string;
  latestContextTokens: number | null;
  latestContextWindow: number | null;
  latestContextModel: string | null;
  latestContextUpdatedAt?: string | null;
}): ChatSessionRecord | null {
  const trimmedSessionId = input.sessionId.trim();
  if (!trimmedSessionId || !getChatSession(trimmedSessionId)) {
    return null;
  }

  const latestContextTokens = Number.isFinite(input.latestContextTokens)
    ? Math.max(0, Math.floor(Number(input.latestContextTokens)))
    : null;
  const latestContextWindow = Number.isFinite(input.latestContextWindow)
    ? Math.max(1, Math.floor(Number(input.latestContextWindow)))
    : null;
  const latestContextModel = typeof input.latestContextModel === 'string' && input.latestContextModel.trim()
    ? input.latestContextModel.trim()
    : null;
  const latestContextUpdatedAt = typeof input.latestContextUpdatedAt === 'string' && input.latestContextUpdatedAt.trim()
    ? normalizeIsoTimestamp(input.latestContextUpdatedAt)
    : new Date().toISOString();

  getDb().prepare(`
    INSERT INTO chat_session_brain_settings (
      session_id,
      latest_context_tokens,
      latest_context_window,
      latest_context_model,
      latest_context_updated_at
    )
    SELECT ?, ?, ?, ?, ?
    WHERE EXISTS (
      SELECT 1
      FROM chat_sessions
      WHERE id = ?
    )
    ON CONFLICT(session_id) DO UPDATE SET
      latest_context_tokens = excluded.latest_context_tokens,
      latest_context_window = excluded.latest_context_window,
      latest_context_model = excluded.latest_context_model,
      latest_context_updated_at = excluded.latest_context_updated_at,
      updated_at = datetime('now')
  `).run(
    trimmedSessionId,
    latestContextTokens,
    latestContextWindow,
    latestContextModel,
    latestContextUpdatedAt,
    trimmedSessionId,
  );

  touchChatSession(trimmedSessionId);
  return getChatSession(trimmedSessionId);
}

export function touchChatSession(sessionId: string): boolean {
  const trimmedSessionId = sessionId.trim();
  if (!trimmedSessionId) return false;

  const result = getDb().prepare(`
    UPDATE chat_sessions
    SET updated_at = datetime('now')
    WHERE id = ?
  `).run(trimmedSessionId);

  return result.changes > 0;
}

export function rotateChatSessionClaudeSessionId(
  sessionId: string,
  nextClaudeSessionId = randomUUID(),
): ChatSessionRecord | null {
  const trimmedSessionId = sessionId.trim();
  if (!trimmedSessionId || !isUuid(nextClaudeSessionId)) return null;

  const result = getDb().prepare(`
    UPDATE chat_sessions
    SET
      provider_session_id = ?,
      claude_session_id = CASE
        WHEN COALESCE(NULLIF(TRIM(provider), ''), 'claude') = 'claude' THEN ?
        ELSE claude_session_id
      END,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(nextClaudeSessionId, nextClaudeSessionId, trimmedSessionId);

  if (result.changes === 0) return null;
  return getChatSession(trimmedSessionId);
}

export function resetChatSessionMessages(sessionId: string): ChatSessionRecord | null {
  const trimmedSessionId = sessionId.trim();
  if (!trimmedSessionId) return null;

  const db = getDb();
  const reset = db.transaction((targetSessionId: string) => {
    const existing = db.prepare(`
      SELECT 1
      FROM chat_sessions
      WHERE id = ?
    `).get(targetSessionId) as { 1?: number } | undefined;

    if (!existing) return null;

    db.prepare(`
      DELETE FROM chat_messages
      WHERE session_id = ?
    `).run(targetSessionId);

    const nextClaudeSessionId = randomUUID();
    db.prepare(`
      UPDATE chat_sessions
      SET
        provider_session_id = ?,
        claude_session_id = CASE
          WHEN COALESCE(NULLIF(TRIM(provider), ''), 'claude') = 'claude' THEN ?
          ELSE claude_session_id
        END,
      updated_at = datetime('now')
      WHERE id = ?
    `).run(nextClaudeSessionId, nextClaudeSessionId, targetSessionId);

    db.prepare(`
      UPDATE chat_session_brain_settings
      SET
        latest_context_tokens = NULL,
        latest_context_window = NULL,
        latest_context_model = NULL,
        latest_context_updated_at = NULL,
        updated_at = datetime('now')
      WHERE session_id = ?
    `).run(targetSessionId);

    return getChatSession(targetSessionId);
  });

  return reset(trimmedSessionId);
}

export function deleteChatSession(sessionId: string): boolean {
  const trimmedSessionId = sessionId.trim();
  if (!trimmedSessionId) return false;

  const db = getDb();
  const remove = db.transaction((targetSessionId: string) => {
    db.prepare(`
      DELETE FROM chat_messages
      WHERE session_id = ?
    `).run(targetSessionId);

    db.prepare(`
      DELETE FROM chat_session_brain_settings
      WHERE session_id = ?
    `).run(targetSessionId);

    const result = db.prepare(`
      DELETE FROM chat_sessions
      WHERE id = ?
    `).run(targetSessionId);

    return result.changes > 0;
  });

  return remove(trimmedSessionId);
}

export function countChatSessions(): number {
  const row = getDb().prepare(`
    SELECT COUNT(*) AS count
    FROM chat_sessions
  `).get() as { count?: number } | undefined;

  return Number(row?.count) || 0;
}

export function getMostRecentChatSession(): ChatSessionRecord | null {
  const row = getDb().prepare(`
    SELECT
      s.id,
      s.provider,
      s.provider_session_id,
      s.claude_session_id,
      s.session_type,
      bs.claude_reasoning_effort,
      bs.codex_reasoning_effort,
      bs.codex_fast_mode,
      bs.latest_context_tokens,
      bs.latest_context_window,
      bs.latest_context_model,
      bs.latest_context_updated_at,
      s.title,
      s.color,
      s.working_directory,
      s.created_at,
      s.updated_at
    FROM chat_sessions AS s
    LEFT JOIN chat_session_brain_settings AS bs
      ON bs.session_id = s.id
    ORDER BY datetime(s.updated_at) DESC, datetime(s.created_at) DESC
    LIMIT 1
  `).get() as ChatSessionRow | undefined;

  return row ? rowToChatSession(row) : null;
}

export function getMostRecentChatSessionForProvider(provider: BrainProviderName | string | null | undefined): ChatSessionRecord | null {
  const normalizedProvider = normalizeBrainProvider(provider);
  const row = getDb().prepare(`
    SELECT
      s.id,
      s.provider,
      s.provider_session_id,
      s.claude_session_id,
      bs.claude_reasoning_effort,
      bs.codex_reasoning_effort,
      bs.codex_fast_mode,
      bs.latest_context_tokens,
      bs.latest_context_window,
      bs.latest_context_model,
      bs.latest_context_updated_at,
      s.title,
      s.color,
      s.working_directory,
      s.created_at,
      s.updated_at
    FROM chat_sessions AS s
    LEFT JOIN chat_session_brain_settings AS bs
      ON bs.session_id = s.id
    WHERE COALESCE(NULLIF(TRIM(s.provider), ''), 'claude') = ?
    ORDER BY datetime(s.updated_at) DESC, datetime(s.created_at) DESC
    LIMIT 1
  `).get(normalizedProvider) as ChatSessionRow | undefined;

  return row ? rowToChatSession(row) : null;
}

function getMostRecentChatSessionBySessionType(sessionType: ConversationSessionType): ChatSessionRecord | null {
  const row = getDb().prepare(`
    SELECT
      s.id,
      s.provider,
      s.provider_session_id,
      s.claude_session_id,
      s.session_type,
      bs.claude_reasoning_effort,
      bs.codex_reasoning_effort,
      bs.codex_fast_mode,
      bs.latest_context_tokens,
      bs.latest_context_window,
      bs.latest_context_model,
      bs.latest_context_updated_at,
      s.title,
      s.color,
      s.working_directory,
      s.created_at,
      s.updated_at
    FROM chat_sessions AS s
    LEFT JOIN chat_session_brain_settings AS bs
      ON bs.session_id = s.id
    WHERE (
      (? IS NULL AND s.session_type IS NULL)
      OR (? IS NOT NULL AND s.session_type = ?)
    )
    ORDER BY datetime(s.updated_at) DESC, datetime(s.created_at) DESC
    LIMIT 1
  `).get(sessionType, sessionType, sessionType) as ChatSessionRow | undefined;

  return row ? rowToChatSession(row) : null;
}

export function getMostRecentGeneralChatSession(): ChatSessionRecord | null {
  return getMostRecentChatSessionBySessionType(null);
}

export function getMostRecentCuratorChatSession(): ChatSessionRecord | null {
  return getMostRecentChatSessionBySessionType('curator');
}

const CONVERSATION_SESSION_STATS_CTE = `
  WITH session_stats AS (
    SELECT
      s.id AS session_id,
      s.provider AS provider,
      s.session_type AS session_type,
      bs.claude_reasoning_effort AS claude_reasoning_effort,
      bs.codex_reasoning_effort AS codex_reasoning_effort,
      bs.codex_fast_mode AS codex_fast_mode,
      bs.latest_context_tokens AS latest_context_tokens,
      bs.latest_context_window AS latest_context_window,
      bs.latest_context_model AS latest_context_model,
      bs.latest_context_updated_at AS latest_context_updated_at,
      s.title AS title,
      s.color AS color,
      s.working_directory AS working_directory,
      s.created_at AS created_at,
      s.updated_at AS updated_at,
      MAX(m.timestamp) AS last_message_timestamp,
      COUNT(m.id) AS message_count,
      SUM(CASE WHEN m.role = 'user' AND m.type = 'chat' THEN 1 ELSE 0 END) AS user_message_count,
      (
        SELECT COUNT(*)
        FROM feed AS f
        WHERE f.origin_session_id = s.id
      ) AS feed_item_count,
      ROW_NUMBER() OVER (
        ORDER BY datetime(s.created_at) ASC, s.id ASC
      ) - 1 AS creation_order_index
    FROM chat_sessions AS s
    LEFT JOIN chat_session_brain_settings AS bs
      ON bs.session_id = s.id
    LEFT JOIN chat_messages AS m
      ON m.session_id = s.id
    GROUP BY
      s.id,
      s.session_type,
      bs.claude_reasoning_effort,
      bs.codex_reasoning_effort,
      bs.codex_fast_mode,
      bs.latest_context_tokens,
      bs.latest_context_window,
      bs.latest_context_model,
      bs.latest_context_updated_at
  )
`;

function isLegacyAgentOnlyOrphan(row: Pick<ConversationSessionAggregateRow, 'session_type' | 'title' | 'message_count' | 'user_message_count' | 'feed_item_count'>): boolean {
  const title = typeof row.title === 'string' ? row.title.trim() : '';
  if (!/^Session \d+$/i.test(title)) {
    return false;
  }

  return Number(row.user_message_count) === 0
    && Number(row.feed_item_count) === 0
    && Number(row.message_count) > 0;
}

function getConversationSessionAggregatePage(offset: number, limit: number): ConversationSessionAggregateRow[] {
  return getDb().prepare(`
    ${CONVERSATION_SESSION_STATS_CTE}
    SELECT
      session_id,
      provider,
      session_type,
      claude_reasoning_effort,
      codex_reasoning_effort,
      codex_fast_mode,
      latest_context_tokens,
      latest_context_window,
      latest_context_model,
      latest_context_updated_at,
      title,
      color,
      working_directory,
      created_at,
      updated_at,
      last_message_timestamp,
      message_count,
      user_message_count,
      feed_item_count,
      creation_order_index
    FROM session_stats
    WHERE NOT (
      user_message_count = 0
      AND title GLOB 'Session *'
      AND feed_item_count = 0
      AND message_count > 0
    )
    ORDER BY datetime(COALESCE(last_message_timestamp, updated_at, created_at)) DESC, datetime(created_at) ASC, session_id ASC
    LIMIT ?
    OFFSET ?
  `).all(limit, offset) as ConversationSessionAggregateRow[];
}

function getConversationSessionAggregateById(sessionId: string): ConversationSessionAggregateRow | null {
  const trimmedSessionId = sessionId.trim();
  if (!trimmedSessionId) return null;

  const row = getDb().prepare(`
    ${CONVERSATION_SESSION_STATS_CTE}
    SELECT
      session_id,
      provider,
      session_type,
      claude_reasoning_effort,
      codex_reasoning_effort,
      codex_fast_mode,
      latest_context_tokens,
      latest_context_window,
      latest_context_model,
      latest_context_updated_at,
      title,
      color,
      working_directory,
      created_at,
      updated_at,
      last_message_timestamp,
      message_count,
      user_message_count,
      feed_item_count,
      creation_order_index
    FROM session_stats
    WHERE session_id = ?
  `).get(trimmedSessionId) as ConversationSessionAggregateRow | undefined;

  if (!row || isLegacyAgentOnlyOrphan(row)) {
    return null;
  }

  return row;
}

function getConversationSessionPreviewRows(sessionId: string, limit = 12): ConversationSessionPreviewRow[] {
  return getDb().prepare(`
    SELECT session_id, id, type, role, text, timestamp, metadata
    FROM chat_messages
    WHERE session_id = ?
    ORDER BY timestamp DESC, created_at DESC
    LIMIT ?
  `).all(sessionId, limit) as ConversationSessionPreviewRow[];
}

function getConversationSessionPreviewRowsBySessionIds(
  sessionIds: string[],
  limit = 12,
): Map<string, ConversationSessionPreviewRow[]> {
  const uniqueSessionIds = Array.from(new Set(
    sessionIds.map((sessionId) => sessionId.trim()).filter(Boolean),
  ));
  if (uniqueSessionIds.length === 0) {
    return new Map();
  }

  const placeholders = uniqueSessionIds.map(() => '?').join(', ');
  const rows = getDb().prepare(`
    SELECT session_id, id, type, role, text, timestamp, metadata
    FROM (
      SELECT
        session_id,
        id,
        type,
        role,
        text,
        timestamp,
        metadata,
        ROW_NUMBER() OVER (
          PARTITION BY session_id
          ORDER BY datetime(timestamp) DESC, datetime(created_at) DESC, id DESC
        ) AS row_number
      FROM chat_messages
      WHERE session_id IN (${placeholders})
    )
    WHERE row_number <= ?
    ORDER BY session_id ASC, datetime(timestamp) DESC, id DESC
  `).all(...uniqueSessionIds, limit) as ConversationSessionPreviewRow[];

  const bySessionId = new Map<string, ConversationSessionPreviewRow[]>();
  for (const row of rows) {
    const sessionId = row.session_id;
    if (!sessionId) {
      continue;
    }
    const existing = bySessionId.get(sessionId) ?? [];
    existing.push(row);
    bySessionId.set(sessionId, existing);
  }

  return bySessionId;
}

function aggregateRowToConversationSessionSummary(
  row: ConversationSessionAggregateRow,
  previewRows = getConversationSessionPreviewRows(row.session_id),
): ConversationSessionSummary {
  const previewMessages = previewRows
    .map(rowToConversationPreviewMessage)
    .filter((message): message is ConversationSessionPreviewMessage => message !== null);
  const preview = buildSessionPreview(previewMessages);
  const context = readConversationContext(previewRows);

  return {
    sessionId: row.session_id,
    provider: normalizeBrainProvider(row.provider),
    sessionType: sanitizeSessionType(row.session_type),
    claudeReasoningEffort: normalizeClaudeReasoningEffort(
      row.claude_reasoning_effort ?? getDefaultClaudeReasoningEffort(),
    ) as ClaudeReasoningEffort,
    codexReasoningEffort: normalizeCodexReasoningEffort(
      row.codex_reasoning_effort ?? getDefaultCodexReasoningEffort(),
    ) as CodexReasoningEffort,
    codexFastMode: normalizeBooleanFlag(row.codex_fast_mode),
    latestContextTokens: Number.isFinite(row.latest_context_tokens) ? Number(row.latest_context_tokens) : null,
    latestContextWindow: Number.isFinite(row.latest_context_window) ? Number(row.latest_context_window) : null,
    latestContextModel: typeof row.latest_context_model === 'string' && row.latest_context_model.trim()
      ? row.latest_context_model.trim()
      : null,
    latestContextUpdatedAt: typeof row.latest_context_updated_at === 'string' && row.latest_context_updated_at.trim()
      ? normalizeIsoTimestamp(row.latest_context_updated_at)
      : null,
    title: sanitizeSessionTitle(row.title) ?? generateSessionTitle(Number(row.creation_order_index) || 0),
    color: sanitizeSessionColor(row.color),
    workingDirectory: sanitizeWorkingDirectory(row.working_directory) ?? process.cwd(),
    lastMaterialActivityAt: normalizeIsoTimestamp(row.last_message_timestamp ?? row.updated_at ?? row.created_at),
    conversationCount: 1,
    messageCount: Number(row.message_count) || 0,
    feedItemCount: Number(row.feed_item_count) || 0,
    previewText: preview.previewText,
    previewMessages: preview.previewMessages,
    lastActor: preview.lastActor,
    contextKind: context.contextKind,
    contextRefId: context.contextRefId,
  };
}

export function getConversationSessionSummary(sessionId: string): ConversationSessionSummary | null {
  const row = getConversationSessionAggregateById(sessionId);
  return row ? aggregateRowToConversationSessionSummary(row) : null;
}

export function getConversationSessionSummariesByIds(sessionIds: string[]): ConversationSessionSummary[] {
  const uniqueSessionIds = Array.from(new Set(
    sessionIds.map((sessionId) => sessionId.trim()).filter(Boolean),
  ));
  if (uniqueSessionIds.length === 0) {
    return [];
  }

  const placeholders = uniqueSessionIds.map(() => '?').join(', ');
  const rows = getDb().prepare(`
    ${CONVERSATION_SESSION_STATS_CTE}
    SELECT
      session_id,
      provider,
      session_type,
      claude_reasoning_effort,
      codex_reasoning_effort,
      codex_fast_mode,
      latest_context_tokens,
      latest_context_window,
      latest_context_model,
      latest_context_updated_at,
      title,
      color,
      working_directory,
      created_at,
      updated_at,
      last_message_timestamp,
      message_count,
      user_message_count,
      feed_item_count,
      creation_order_index
    FROM session_stats
    WHERE session_id IN (${placeholders})
  `).all(...uniqueSessionIds) as ConversationSessionAggregateRow[];

  const rowsBySessionId = new Map<string, ConversationSessionAggregateRow>();
  for (const row of rows) {
    if (!isLegacyAgentOnlyOrphan(row)) {
      rowsBySessionId.set(row.session_id, row);
    }
  }

  const previewRowsBySessionId = getConversationSessionPreviewRowsBySessionIds(
    Array.from(rowsBySessionId.keys()),
  );

  return uniqueSessionIds
    .map((sessionId) => {
      const row = rowsBySessionId.get(sessionId);
      return row
        ? aggregateRowToConversationSessionSummary(row, previewRowsBySessionId.get(sessionId) ?? [])
        : null;
    })
    .filter((session): session is ConversationSessionSummary => session !== null);
}

export function getConversationSessionPage(input?: { limit?: number; offset?: number }): ConversationSessionPage {
  const safeLimit = Number.isFinite(input?.limit) ? Math.max(1, Math.min(100, Math.floor(input!.limit!))) : 24;
  const safeOffset = Number.isFinite(input?.offset) ? Math.max(0, Math.floor(input!.offset!)) : 0;
  const totalRow = getDb().prepare(`
    ${CONVERSATION_SESSION_STATS_CTE}
    SELECT COUNT(*) AS count
    FROM session_stats
    WHERE NOT (
      user_message_count = 0
      AND title GLOB 'Session *'
      AND feed_item_count = 0
      AND message_count > 0
    )
  `).get() as { count?: number } | undefined;
  const totalCount = Number(totalRow?.count) || 0;
  const rows = getConversationSessionAggregatePage(safeOffset, safeLimit);
  const previewRowsBySessionId = getConversationSessionPreviewRowsBySessionIds(rows.map((row) => row.session_id));
  const sessions = rows.map((row) => aggregateRowToConversationSessionSummary(
    row,
    previewRowsBySessionId.get(row.session_id) ?? [],
  ));

  return {
    sessions,
    count: sessions.length,
    totalCount,
    hasMore: safeOffset + sessions.length < totalCount,
    nextOffset: safeOffset + sessions.length < totalCount ? safeOffset + sessions.length : null,
  };
}

export function getConversationSessions(limit = 24): ConversationSessionSummary[] {
  return getConversationSessionPage({ limit }).sessions;
}
