function normalizeIsoTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return new Date().toISOString();
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return new Date().toISOString();
  }

  return parsed.toISOString();
}

function upsertChatSessionContextMetrics(db, input) {
  if (!db || !input || typeof input !== 'object') {
    return false;
  }

  const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
  if (!sessionId) {
    return false;
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
  const latestContextUpdatedAt = normalizeIsoTimestamp(input.latestContextUpdatedAt);

  const result = db.prepare(`
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
    sessionId,
    latestContextTokens,
    latestContextWindow,
    latestContextModel,
    latestContextUpdatedAt,
    sessionId,
  );

  if (result.changes === 0) {
    return false;
  }

  db.prepare(`
    UPDATE chat_sessions
    SET updated_at = datetime('now')
    WHERE id = ?
  `).run(sessionId);

  return true;
}

module.exports = {
  upsertChatSessionContextMetrics,
};
