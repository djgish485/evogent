const { createHash, randomUUID } = require('node:crypto');
const {
  OPENCLAW_UNREACHABLE_MESSAGE,
  getOpenClawSettingsView,
} = require('./config.js');
const {
  getOpenClawGatewayClient,
  normalizeGatewayErrorMessage,
} = require('./gateway-client.js');
const {
  isOpenClawHeartbeatMessage,
} = require('./heartbeat.js');

const OPENCLAW_SESSION_PREFIX = 'openclaw:';

function toOpenClawSessionId(sessionKey) {
  return `${OPENCLAW_SESSION_PREFIX}${sessionKey}`;
}

function fromOpenClawSessionId(sessionId) {
  if (typeof sessionId !== 'string') return null;
  return sessionId.startsWith(OPENCLAW_SESSION_PREFIX)
    ? sessionId.slice(OPENCLAW_SESSION_PREFIX.length)
    : null;
}

function normalizeTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return new Date(parsed).toISOString();
    }
  }
  return new Date().toISOString();
}

function truncateText(value, max = 180) {
  const text = typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim()
    : '';
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 3).trimEnd()}...` : text;
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    if (typeof part.text === 'string') return part.text;
    if (typeof part.content === 'string') return part.content;
    if (typeof part.name === 'string' && part.type === 'toolcall') return `Tool call: ${part.name}`;
    if (typeof part.name === 'string' && part.type === 'toolresult') return `Tool result: ${part.name}`;
    return '';
  }).filter(Boolean).join('\n\n');
}

function getMessageText(message) {
  if (!message || typeof message !== 'object') return '';
  return textFromContent(message.text)
    || textFromContent(message.content)
    || textFromContent(message.parts)
    || textFromContent(message.message)
    || '';
}

function getMessageRole(message) {
  const role = typeof message?.role === 'string' ? message.role.trim().toLowerCase() : '';
  return role === 'user' ? 'user' : 'agent';
}

function firstTrimmedString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function getRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function getMessageIdempotencyKey(message, fallback = null) {
  const metadata = getRecord(message?.metadata);
  return firstTrimmedString(
    fallback,
    message?.idempotencyKey,
    message?.idempotency_key,
    message?.clientRequestId,
    message?.client_request_id,
    metadata?.idempotencyKey,
    metadata?.idempotency_key,
    metadata?.clientRequestId,
    metadata?.client_request_id,
  );
}

function stableMessageId(sessionKey, message, index = 0) {
  const explicitId = typeof message?.id === 'string' && message.id.trim()
    ? message.id.trim()
    : typeof message?.messageId === 'string' && message.messageId.trim()
      ? message.messageId.trim()
      : '';
  if (explicitId) return `openclaw-${createHash('sha1').update(`${sessionKey}:${explicitId}`).digest('hex').slice(0, 24)}`;

  const digest = createHash('sha1')
    .update(`${sessionKey}:${index}:${getMessageRole(message)}:${normalizeTimestamp(message?.timestamp ?? message?.ts ?? message?.createdAt)}:${getMessageText(message)}`)
    .digest('hex')
    .slice(0, 24);
  return `openclaw-${digest}`;
}

function normalizeOpenClawMessage(sessionKey, message, options = {}) {
  const text = getMessageText(message).trim();
  if (!text) return null;

  const role = getMessageRole(message);
  const timestamp = normalizeTimestamp(message?.timestamp ?? message?.ts ?? message?.createdAt ?? message?.created_at);
  const id = options.id || stableMessageId(sessionKey, message, options.index ?? 0);
  const idempotencyKey = getMessageIdempotencyKey(message, options.idempotencyKey);
  return {
    type: 'chat',
    id,
    role,
    inReplyTo: options.inReplyTo ?? null,
    sessionId: toOpenClawSessionId(sessionKey),
    text,
    timestamp,
    context: null,
    status: 'delivered',
    metadata: {
      source: 'openclaw',
      openclawSessionKey: sessionKey,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(typeof message?.runId === 'string' ? { runId: message.runId } : {}),
    },
    createdAt: timestamp,
  };
}

function normalizeOpenClawMessages(sessionKey, messages) {
  const normalized = [];
  let lastUserMessageId = null;
  (Array.isArray(messages) ? messages : []).forEach((message, index) => {
    const role = getMessageRole(message);
    const item = normalizeOpenClawMessage(sessionKey, message, {
      index,
      inReplyTo: role === 'agent' ? lastUserMessageId : null,
    });
    if (!item) return;
    normalized.push(item);
    if (item.role === 'user') {
      lastUserMessageId = item.id;
    }
  });
  return normalized;
}

const GENERATED_OPENCLAW_LABEL_PREFIX = /^\s*\[(?:(?:mon|tue|wed|thu|fri|sat|sun)\s+)?\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}(?::\d{2})?\s+(?:utc|gmt|z)\]\s*/i;

function stripGeneratedSessionLabelPrefix(value) {
  return typeof value === 'string'
    ? value.replace(GENERATED_OPENCLAW_LABEL_PREFIX, '').replace(/\s+/g, ' ').trim()
    : '';
}

function titleFromUserText(value) {
  const text = typeof value === 'string' ? value : '';
  const raw = text
    .split(/\n\nContext\s/i)[0]
    ?.replace(/^Chat:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim() || '';
  return truncateText(raw, 96);
}

function getFirstUserMessageTextFromMessages(messages) {
  for (const message of Array.isArray(messages) ? messages : []) {
    if (getMessageRole(message) !== 'user') continue;
    if (isOpenClawHeartbeatMessage(message)) continue;
    const text = getMessageText(message).trim();
    if (text) return text;
  }
  return '';
}

function getVisibleUserMessageText(value) {
  const message = typeof value === 'string' ? { role: 'user', text: value } : value;
  if (!message || isOpenClawHeartbeatMessage(message)) return '';
  return getMessageText(message).trim();
}

function getFirstUserMessageTextFromSession(session) {
  return firstTrimmedString(
    getVisibleUserMessageText(session?.firstUserMessageText),
    getVisibleUserMessageText(session?.firstUserMessage),
    getVisibleUserMessageText(session?.lastUserMessage),
    getFirstUserMessageTextFromMessages(session?.messages),
    getFirstUserMessageTextFromMessages(session?.history),
    getFirstUserMessageTextFromMessages(session?.recentMessages),
  );
}

function isGenericSessionLabel(value, key) {
  const label = typeof value === 'string' ? value.trim() : '';
  if (!label) return true;
  if (/^openclaw session$/i.test(label)) return true;
  if (key && label === key) return true;
  if (/^agent:[a-z0-9:_-]+$/i.test(label)) return true;
  return false;
}

function normalizeSessionLabel(session) {
  const key = typeof session?.key === 'string' ? session.key.trim() : '';
  const isCurator = session?.sessionType === 'curator' || /^agent:curator:/.test(key);
  const firstUserTitle = titleFromUserText(getFirstUserMessageTextFromSession(session));
  const candidates = [
    session?.label,
    session?.displayName,
    session?.derivedTitle,
    session?.subject,
    session?.title,
  ].map(stripGeneratedSessionLabelPrefix);
  const label = candidates.find((candidate) => !isGenericSessionLabel(candidate, key)) || '';

  if (isCurator) {
    return firstUserTitle ? truncateText(`Curator: ${firstUserTitle}`, 96) : 'Curator';
  }

  return truncateText(label || firstUserTitle || 'OpenClaw session', 96) || 'OpenClaw session';
}

function normalizeLastMessagePreview(value) {
  if (typeof value === 'string') {
    if (isOpenClawHeartbeatMessage({ role: 'user', text: value }) || isOpenClawHeartbeatMessage({ role: 'agent', text: value })) {
      return '';
    }
    return truncateText(value);
  }
  if (value && typeof value === 'object') {
    if (isOpenClawHeartbeatMessage(value)) return '';
    return truncateText(getMessageText(value) || value.text || value.preview || '');
  }
  return '';
}

function getLastVisibleMessagePreviewFromMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (isOpenClawHeartbeatMessage(message)) continue;
    const preview = normalizeLastMessagePreview(message);
    if (preview) return preview;
  }
  return '';
}

function countVisibleMessages(messages) {
  if (!Array.isArray(messages)) return null;
  return messages.filter((message) => !isOpenClawHeartbeatMessage(message)).length;
}

function normalizeOpenClawSession(session) {
  const key = typeof session?.key === 'string' && session.key.trim() ? session.key.trim() : '';
  if (!key) return null;
  const updatedAt = normalizeTimestamp(session.updatedAt ?? session.lastInteractionAt ?? session.startedAt);
  const preview = firstTrimmedString(
    normalizeLastMessagePreview(session.lastMessagePreview),
    normalizeLastMessagePreview(session.lastMessage),
    getLastVisibleMessagePreviewFromMessages(session.messages),
    getLastVisibleMessagePreviewFromMessages(session.history),
    getLastVisibleMessagePreviewFromMessages(session.recentMessages),
  );
  const sessionType = /^agent:curator:/.test(key) ? 'curator' : null;
  const firstUserMessageText = getFirstUserMessageTextFromSession(session);
  const rawUserMessageCount = Number(session.userMessageCount ?? session.userAuthoredMessageCount ?? session.userMessages);
  const visibleMessageCount = firstTrimmedString(
    countVisibleMessages(session.messages)?.toString(),
    countVisibleMessages(session.history)?.toString(),
    countVisibleMessages(session.recentMessages)?.toString(),
  );
  return {
    key,
    sessionId: toOpenClawSessionId(key),
    label: normalizeSessionLabel({ ...session, firstUserMessageText, sessionType }),
    sessionType,
    preview,
    updatedAt,
    messageCount: visibleMessageCount
      ? Number(visibleMessageCount)
      : typeof session.messageCount === 'number' && Number.isFinite(session.messageCount)
      ? Math.max(0, session.messageCount)
      : null,
    hasUserActivity: Boolean(firstUserMessageText) || (Number.isFinite(rawUserMessageCount) && rawUserMessageCount > 0),
    firstUserMessageText,
    status: typeof session.status === 'string' && session.status.trim() ? session.status.trim() : null,
    agentId: typeof session.agentId === 'string' && session.agentId.trim() ? session.agentId.trim() : null,
    raw: session,
  };
}

async function fetchOpenClawSessionUserActivity(client, sessionKey) {
  try {
    const payload = await client.request('chat.history', {
      sessionKey,
      limit: 1_000,
      maxChars: 100_000,
    });
    const visibleMessages = (Array.isArray(payload?.messages) ? payload.messages : [])
      .filter((message) => !isOpenClawHeartbeatMessage(message));
    const firstUserMessageText = getFirstUserMessageTextFromMessages(payload?.messages);
    return {
      hasUserActivity: Boolean(firstUserMessageText),
      firstUserMessageText,
      lastMessagePreview: getLastVisibleMessagePreviewFromMessages(visibleMessages),
      visibleMessageCount: visibleMessages.length,
    };
  } catch {
    return {
      hasUserActivity: false,
      firstUserMessageText: '',
      lastMessagePreview: '',
      visibleMessageCount: null,
    };
  }
}

async function listOpenClawSessions(options = {}) {
  const client = getOpenClawGatewayClient();
  try {
    const includeSessionKey = typeof options.includeSessionKey === 'string' && options.includeSessionKey.trim()
      ? options.includeSessionKey.trim()
      : null;
    const payload = await client.request('sessions.list', {
      limit: options.limit ?? 100,
      includeDerivedTitles: true,
      includeLastMessage: true,
    });
    await client.subscribeSessions().catch(() => {});

    const sessions = (Array.isArray(payload?.sessions) ? payload.sessions : [])
      .map(normalizeOpenClawSession)
      .filter(Boolean);
    const inspectedSessions = await Promise.all(sessions.map(async (session) => {
      const shouldInspectHistory = session.sessionType === 'curator'
        || (!session.firstUserMessageText && (session.messageCount ?? 0) > 0)
        || (!session.hasUserActivity && (session.messageCount === 0 || session.messageCount === null));
      if (!shouldInspectHistory) {
        return session;
      }

      const activity = await fetchOpenClawSessionUserActivity(client, session.key);
      if (!activity.hasUserActivity && !activity.firstUserMessageText && activity.visibleMessageCount === null) {
        return session;
      }

      return {
        ...session,
        hasUserActivity: activity.hasUserActivity,
        firstUserMessageText: activity.firstUserMessageText,
        preview: activity.lastMessagePreview || session.preview,
        messageCount: activity.visibleMessageCount ?? session.messageCount,
        label: normalizeSessionLabel({
          ...session.raw,
          key: session.key,
          sessionType: session.sessionType,
          firstUserMessageText: activity.firstUserMessageText,
        }),
      };
    }));
    const filteredSessions = inspectedSessions
      .filter((session) => (
        session.key === includeSessionKey
        || session.hasUserActivity
        || (session.messageCount ?? 0) > 0
      ))
      .sort((left, right) => {
        if (left.hasUserActivity !== right.hasUserActivity) {
          return left.hasUserActivity ? -1 : 1;
        }
        return right.updatedAt.localeCompare(left.updatedAt);
      });

    return {
      ok: true,
      reachable: true,
      sessions: filteredSessions,
      error: null,
      settings: getOpenClawSettingsView(),
    };
  } catch (error) {
    return {
      ok: false,
      reachable: false,
      sessions: [],
      error: normalizeGatewayErrorMessage(error) || OPENCLAW_UNREACHABLE_MESSAGE,
      settings: getOpenClawSettingsView(),
    };
  }
}

async function getOpenClawHistory(sessionKey, options = {}) {
  const key = typeof sessionKey === 'string' ? sessionKey.trim() : '';
  if (!key) throw new Error('OpenClaw session key is required');

  const client = getOpenClawGatewayClient();
  await client.subscribeSessionMessages(key).catch(() => {});
  const payload = await client.request('chat.history', {
    sessionKey: key,
    limit: options.limit ?? 250,
    maxChars: options.maxChars ?? 20_000,
  });

  return {
    sessionKey: key,
    sessionId: toOpenClawSessionId(key),
    messages: normalizeOpenClawMessages(key, payload?.messages ?? []),
  };
}

async function sendOpenClawMessage(sessionKey, text, options = {}) {
  const key = typeof sessionKey === 'string' ? sessionKey.trim() : '';
  const message = typeof text === 'string' ? text.trim() : '';
  if (!key) throw new Error('OpenClaw session key is required');
  if (!message) throw new Error('message must be a non-empty string');

  const client = getOpenClawGatewayClient();
  await client.subscribeSessionMessages(key).catch(() => {});
  const idempotencyKey = options.idempotencyKey || `evogent-${randomUUID()}`;
  const payload = await client.request('chat.send', {
    sessionKey: key,
    message,
    idempotencyKey,
  });
  const timestamp = new Date().toISOString();
  const userMessage = {
    type: 'chat',
    id: `openclaw-user-${idempotencyKey}`,
    role: 'user',
    inReplyTo: null,
    sessionId: toOpenClawSessionId(key),
    text: message,
    timestamp,
    context: null,
    status: 'delivered',
    metadata: {
      source: 'openclaw',
      openclawSessionKey: key,
      idempotencyKey,
    },
    createdAt: timestamp,
  };

  return {
    ok: true,
    sessionKey: key,
    sessionId: toOpenClawSessionId(key),
    runId: typeof payload?.runId === 'string' ? payload.runId : idempotencyKey,
    userMessage,
  };
}

function normalizeOpenClawGatewayEvent(eventFrame) {
  const event = eventFrame?.event;
  const payload = eventFrame?.payload || {};
  if (event === 'sessions.changed') {
    const sessionKey = typeof payload.sessionKey === 'string' && payload.sessionKey.trim() ? payload.sessionKey.trim() : null;
    const session = payload.session && typeof payload.session === 'object' ? payload.session : payload;
    const status = typeof session.status === 'string' ? session.status.trim().toLowerCase() : '';
    const hasActiveRun = session.hasActiveRun ?? payload.hasActiveRun;
    const endedAt = session.endedAt ?? payload.endedAt;
    const changed = {
      type: 'openclaw_sessions_changed',
      sessionKey,
      ts: new Date().toISOString(),
    };
    if (sessionKey && (status === 'failed' || (hasActiveRun === false && endedAt != null && status !== 'done' && status !== 'completed'))) {
      const error = [payload.errorMessage, payload.error, session.errorMessage, session.error]
        .find((value) => typeof value === 'string' && value.trim())?.trim() || 'OpenClaw run failed';
      return [changed, {
        type: 'openclaw_session_done',
        sessionKey,
        sessionId: toOpenClawSessionId(sessionKey),
        runId: typeof payload.runId === 'string' && payload.runId.trim() ? payload.runId.trim() : null,
        state: 'error',
        error,
        ts: changed.ts,
      }];
    }
    return changed;
  }

  if (event === 'chat') {
    const sessionKey = typeof payload.sessionKey === 'string' && payload.sessionKey.trim()
      ? payload.sessionKey.trim()
      : '';
    if (!sessionKey) return null;

    const state = typeof payload.state === 'string' && payload.state.trim()
      ? payload.state.trim()
      : '';
    const runId = typeof payload.runId === 'string' && payload.runId.trim()
      ? payload.runId.trim()
      : null;
    const text = getMessageText(payload.message).trim();

    if (state === 'delta') {
      return {
        type: 'openclaw_session_streaming',
        sessionKey,
        sessionId: toOpenClawSessionId(sessionKey),
        runId,
        text,
        ts: new Date().toISOString(),
      };
    }

    if (state === 'final' || state === 'done' || state === 'aborted' || state === 'error') {
      return {
        type: 'openclaw_session_done',
        sessionKey,
        sessionId: toOpenClawSessionId(sessionKey),
        runId,
        state,
        error: typeof payload.errorMessage === 'string' && payload.errorMessage.trim()
          ? payload.errorMessage.trim()
          : null,
        ts: new Date().toISOString(),
      };
    }

    return null;
  }

  if (event === 'session.message') {
    const sessionKey = typeof payload.sessionKey === 'string' && payload.sessionKey.trim()
      ? payload.sessionKey.trim()
      : '';
    const message = normalizeOpenClawMessage(sessionKey, payload.message, {
      id: typeof payload.messageId === 'string' && payload.messageId.trim()
        ? `openclaw-${createHash('sha1').update(`${sessionKey}:${payload.messageId}`).digest('hex').slice(0, 24)}`
        : undefined,
      idempotencyKey: getMessageIdempotencyKey(payload.message, payload.idempotencyKey ?? payload.idempotency_key),
    });
    if (!sessionKey || !message) return null;
    return {
      type: 'openclaw_session_message',
      sessionKey,
      sessionId: toOpenClawSessionId(sessionKey),
      message,
      ts: new Date().toISOString(),
    };
  }

  if (event === 'session.tool') {
    const sessionKey = typeof payload.sessionKey === 'string' && payload.sessionKey.trim()
      ? payload.sessionKey.trim()
      : '';
    if (!sessionKey) return null;
    const toolName = typeof payload.data?.name === 'string' && payload.data.name.trim()
      ? payload.data.name.trim()
      : 'OpenClaw tool';
    const phase = typeof payload.data?.phase === 'string' && payload.data.phase.trim()
      ? payload.data.phase.trim()
      : 'working';
    return {
      type: 'openclaw_session_tool',
      sessionKey,
      sessionId: toOpenClawSessionId(sessionKey),
      tool: toolName,
      activity: `${toolName}: ${phase}`,
      ts: new Date().toISOString(),
    };
  }

  if (event === 'shutdown') {
    return {
      type: 'openclaw_status',
      connected: false,
      error: 'OpenClaw is restarting',
      ts: new Date().toISOString(),
    };
  }

  return null;
}

module.exports = {
  OPENCLAW_SESSION_PREFIX,
  fromOpenClawSessionId,
  getOpenClawHistory,
  listOpenClawSessions,
  normalizeOpenClawGatewayEvent,
  normalizeOpenClawMessage,
  normalizeOpenClawMessages,
  isOpenClawHeartbeatMessage,
  sendOpenClawMessage,
  toOpenClawSessionId,
};
