import { shouldDisplayAgentEventInChat } from '@/lib/chat-agent-events';
import { normalizeChatMessageText } from '@/lib/chat-text';
import { escapeSqlLikePattern, tokenizeSearchQuery } from '@/lib/search-utils';
import type { ChatMessage, ChatMessageStatus } from '@/types/chat';
import type { ChatSessionSearchMatch } from '@/types/feed';
import { getDb } from './client';
import { getConversationSessionSummariesByIds } from './chat-sessions';

const CHAT_SEARCH_SCAN_LIMIT = 5_000;
const CHAT_SEARCH_SESSION_LIMIT = 50;
const CHAT_SEARCH_MESSAGES_PER_SESSION = 3;

interface ChatSearchMessageRow {
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
  return new Date(Math.min(parsed.getTime(), Date.now())).toISOString();
}

function rowToChatMessage(row: ChatSearchMessageRow): ChatMessage | null {
  const type = row.type === 'agent_event' ? 'agent_event' : 'chat';
  const role = row.role === 'user' ? 'user' : 'agent';
  const metadata = parseJsonRecord(row.metadata) ?? {};
  if (row.task_id && typeof metadata.taskId !== 'string') {
    metadata.taskId = row.task_id;
  }

  const message: ChatMessage = {
    type,
    id: row.id,
    role,
    inReplyTo: row.in_reply_to,
    sessionId: row.session_id,
    text: normalizeChatMessageText(row.text, { role, type }),
    timestamp: normalizeTimestamp(row.timestamp),
    context: row.context,
    status: row.status as ChatMessageStatus | null,
    metadata: Object.keys(metadata).length > 0 ? metadata : null,
    createdAt: row.created_at,
  };

  return shouldDisplayAgentEventInChat(message) ? message : null;
}

export function getChatSessionSearchMatches(search: string | null | undefined): ChatSessionSearchMatch[] {
  const tokens = tokenizeSearchQuery(search);
  if (tokens.length === 0) {
    return [];
  }

  const searchClauses = tokens.map(() => `lower(text) LIKE ? ESCAPE '\\'`).join(' OR ');
  const rows = getDb().prepare(`
    WITH recent_messages AS (
      SELECT *
      FROM chat_messages AS m
      WHERE m.type = 'chat'
        AND m.session_id IS NOT NULL
        AND NOT EXISTS (
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
      ORDER BY datetime(m.timestamp) DESC, datetime(m.created_at) DESC, m.id DESC
      LIMIT ?
    ),
    matching_messages AS (
      SELECT *
      FROM recent_messages
      WHERE ${searchClauses}
    ),
    selected_sessions AS (
      SELECT
        session_id,
        MAX(datetime(timestamp)) AS latest_match_time
      FROM matching_messages
      GROUP BY session_id
      ORDER BY latest_match_time DESC, session_id ASC
      LIMIT ?
    ),
    ranked_messages AS (
      SELECT
        matching_messages.*,
        ROW_NUMBER() OVER (
          PARTITION BY matching_messages.session_id
          ORDER BY datetime(matching_messages.timestamp) DESC, datetime(matching_messages.created_at) DESC, matching_messages.id DESC
        ) AS match_rank
      FROM matching_messages
      INNER JOIN selected_sessions
        ON selected_sessions.session_id = matching_messages.session_id
    )
    SELECT ranked_messages.*
    FROM ranked_messages
    INNER JOIN selected_sessions
      ON selected_sessions.session_id = ranked_messages.session_id
    WHERE ranked_messages.match_rank <= ?
    ORDER BY
      selected_sessions.latest_match_time DESC,
      datetime(ranked_messages.timestamp) DESC,
      datetime(ranked_messages.created_at) DESC,
      ranked_messages.id DESC
  `).all(
    CHAT_SEARCH_SCAN_LIMIT,
    ...tokens.map((token) => `%${escapeSqlLikePattern(token)}%`),
    CHAT_SEARCH_SESSION_LIMIT,
    CHAT_SEARCH_MESSAGES_PER_SESSION,
  ) as ChatSearchMessageRow[];

  if (rows.length === 0) {
    return [];
  }

  const messagesBySessionId = new Map<string, ChatMessage[]>();
  for (const row of rows) {
    const message = rowToChatMessage(row);
    const sessionId = message?.sessionId?.trim();
    if (!message || !sessionId) {
      continue;
    }
    const messages = messagesBySessionId.get(sessionId) ?? [];
    messages.push(message);
    messagesBySessionId.set(sessionId, messages);
  }

  const sessionIds = Array.from(messagesBySessionId.keys());
  const summariesBySessionId = new Map(
    getConversationSessionSummariesByIds(sessionIds).map((session) => [session.sessionId, session]),
  );

  return sessionIds
    .map((sessionId) => {
      const messages = messagesBySessionId.get(sessionId) ?? [];
      const latestMessage = messages[0] ?? null;
      if (!latestMessage) {
        return null;
      }

      return {
        sessionId,
        latestMessageId: latestMessage.id,
        latestMessageTimestamp: latestMessage.timestamp,
        messages: [...messages].sort((left, right) => left.timestamp.localeCompare(right.timestamp)),
        session: summariesBySessionId.get(sessionId) ?? null,
      } satisfies ChatSessionSearchMatch;
    })
    .filter((match): match is ChatSessionSearchMatch => match !== null);
}
