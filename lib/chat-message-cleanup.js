function failStaleQueuedChatMessages(db) {
  if (!db || typeof db.prepare !== 'function') {
    return 0;
  }

  const result = db.prepare(`
    UPDATE chat_messages
    SET status = 'failed'
    WHERE role = 'user'
      AND type = 'chat'
      AND status IN ('pending', 'queued', 'processing')
      AND NOT EXISTS (
        SELECT 1
        FROM chat_messages AS reply
        WHERE reply.in_reply_to = chat_messages.id
          AND reply.role = 'agent'
          AND reply.type = 'chat'
      )
  `).run();

  return Number(result?.changes || 0);
}

module.exports = {
  failStaleQueuedChatMessages,
};
