function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    if (typeof part.text === 'string') return part.text;
    if (typeof part.content === 'string') return part.content;
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

function isHeartbeatRespondJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const keys = Object.keys(parsed);
  const expectedKeys = ['notify', 'outcome', 'status', 'summary'];
  if (keys.length !== expectedKeys.length || keys.some((key) => !expectedKeys.includes(key))) {
    return false;
  }

  return typeof parsed.status === 'string'
    && typeof parsed.outcome === 'string'
    && typeof parsed.notify === 'boolean'
    && typeof parsed.summary === 'string';
}

function isHeartbeatMarkdownTemplate(text) {
  return text
    .trimStart()
    .replace(/\r\n/g, '\n')
    .startsWith('```markdown\n# Keep this file empty (or with only comments) to skip heartbeat API calls.');
}

function isOpenClawHeartbeatMessage(message) {
  const role = getMessageRole(message);
  const text = getMessageText(message);
  if (!text.trim()) return false;

  if (role === 'user') {
    return /^\s*Read\s+HEARTBEAT\.md\b/i.test(text);
  }

  const trimmedText = text.trim();
  return isHeartbeatRespondJson(trimmedText) || isHeartbeatMarkdownTemplate(text);
}

module.exports = {
  isOpenClawHeartbeatMessage,
};
