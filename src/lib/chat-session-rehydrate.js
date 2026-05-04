function normalizeHistoryLimit(limit, fallback = 24) {
  if (!Number.isFinite(limit)) {
    return fallback;
  }

  return Math.max(1, Math.min(30, Math.floor(limit)));
}

function normalizeMessageCharLimit(limit, fallback = 400) {
  if (!Number.isFinite(limit)) {
    return fallback;
  }

  return Math.max(80, Math.min(500, Math.floor(limit)));
}

function normalizeBlockCharBudget(limit, fallback = 9000) {
  if (!Number.isFinite(limit)) {
    return fallback;
  }

  return Math.max(500, Math.min(16000, Math.floor(limit)));
}

function compactMessageText(text, maxChars) {
  if (typeof text !== 'string') {
    return '';
  }

  const compact = text.replace(/\s+/g, ' ').trim();
  if (!compact) {
    return '';
  }

  if (compact.length <= maxChars) {
    return compact;
  }

  return `${compact.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function formatHistoryTimestamp(timestamp) {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return 'unknown time';
  }

  const iso = parsed.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function formatHistoryRole(role) {
  return role === 'user' ? 'User' : 'Agent';
}

function getRecentChatMessages(db, {
  limit = 24,
  sessionId = null,
  excludeMessageId = null,
} = {}) {
  if (!db || typeof db.prepare !== 'function') {
    return [];
  }

  const safeLimit = normalizeHistoryLimit(limit);
  const normalizedSessionId = typeof sessionId === 'string' && sessionId.trim()
    ? sessionId.trim()
    : null;
  const excludedId = typeof excludeMessageId === 'string' && excludeMessageId.trim()
    ? excludeMessageId.trim()
    : null;
  let rows = [];

  if (!normalizedSessionId) {
    return [];
  }

  try {
    rows = excludedId
      ? db.prepare(`
        SELECT id, role, text, timestamp
        FROM chat_messages
        WHERE type = 'chat'
          AND session_id = ?
          AND id != ?
        ORDER BY timestamp DESC, created_at DESC
        LIMIT ?
      `).all(normalizedSessionId, excludedId, safeLimit)
      : db.prepare(`
        SELECT id, role, text, timestamp
        FROM chat_messages
        WHERE type = 'chat'
          AND session_id = ?
        ORDER BY timestamp DESC, created_at DESC
        LIMIT ?
      `).all(normalizedSessionId, safeLimit);
  } catch {
    return [];
  }

  return rows.reverse().map((row) => ({
    id: typeof row.id === 'string' ? row.id : '',
    role: row.role === 'user' ? 'user' : 'agent',
    text: typeof row.text === 'string' ? row.text : '',
    timestamp: typeof row.timestamp === 'string' ? row.timestamp : '',
  }));
}

function buildSessionResetHistoryBlock(messages, {
  perMessageCharLimit = 400,
  maxBlockChars = 9000,
} = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return '';
  }

  const safePerMessageCharLimit = normalizeMessageCharLimit(perMessageCharLimit);
  const safeMaxBlockChars = normalizeBlockCharBudget(maxBlockChars);
  const prefix = '[Session was reset - prior conversation history for context:]';
  const suffix = '[End of prior history. Current message follows.]';
  const formattedLines = messages
    .map((message) => {
      const compactText = compactMessageText(message?.text, safePerMessageCharLimit);
      if (!compactText) {
        return null;
      }

      return `${formatHistoryRole(message?.role)} (${formatHistoryTimestamp(message?.timestamp)}): ${compactText}`;
    })
    .filter(Boolean);

  if (formattedLines.length === 0) {
    return '';
  }

  while (formattedLines.length > 0) {
    const candidate = [prefix, ...formattedLines, suffix].join('\n');
    if (candidate.length <= safeMaxBlockChars) {
      return candidate;
    }
    formattedLines.shift();
  }

  return '';
}

module.exports = {
  buildSessionResetHistoryBlock,
  getRecentChatMessages,
};
