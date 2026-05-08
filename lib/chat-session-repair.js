const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const SYNTHETIC_MODEL = '<synthetic>';
const DEFAULT_MAX_REAL_ASSISTANT_SEARCH_LINES = 50;
const API_ERROR_PATTERN = /\bAPI Error:\s*\d+\b/i;
const RECOVERABLE_IMAGE_ERROR_PATTERN = /\b(?:could not process image|image fetch failed|could not download(?: the)? image|failed to (?:download|fetch)(?: the)? image|unable to (?:download|fetch)(?: the)? image|image (?:url|source|file)[^.\n]*(?:unreachable|expired|invalid|failed|not found|404))\b/i;

function normalizeSessionId(sessionId) {
  return typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : null;
}

function resolveClaudeProjectDirName(workingDirectory) {
  const normalizedWorkingDirectory = typeof workingDirectory === 'string' && workingDirectory.trim()
    ? path.resolve(workingDirectory.trim())
    : process.cwd();
  return normalizedWorkingDirectory.replace(/[\\/]+/g, '-');
}

function resolveClaudeSessionJsonlPath({
  workingDirectory,
  sessionId,
  homeDir = os.homedir(),
  claudeProjectsDir = null,
} = {}) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (!normalizedSessionId) {
    return null;
  }

  const projectsDir = typeof claudeProjectsDir === 'string' && claudeProjectsDir.trim()
    ? claudeProjectsDir.trim()
    : path.join(homeDir || os.homedir(), '.claude', 'projects');
  return path.join(projectsDir, resolveClaudeProjectDirName(workingDirectory), `${normalizedSessionId}.jsonl`);
}

function safeParseJsonLine(line) {
  if (typeof line !== 'string' || !line.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function getAssistantModel(event) {
  if (!event || typeof event !== 'object' || event.type !== 'assistant') {
    return null;
  }

  const message = event.message && typeof event.message === 'object' ? event.message : null;
  const model = typeof message?.model === 'string' && message.model.trim()
    ? message.model.trim()
    : typeof event.model === 'string' && event.model.trim()
      ? event.model.trim()
      : null;
  return model;
}

function isAssistantEvent(event) {
  return getAssistantModel(event) !== null
    || Boolean(event && typeof event === 'object' && event.type === 'assistant');
}

function collectTextContent(value, output = []) {
  if (typeof value === 'string') {
    output.push(value);
    return output;
  }

  if (!value || typeof value !== 'object') {
    return output;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectTextContent(item, output);
    }
    return output;
  }

  if (typeof value.text === 'string') {
    output.push(value.text);
  }

  if (Object.prototype.hasOwnProperty.call(value, 'content')) {
    collectTextContent(value.content, output);
  }

  return output;
}

function getAssistantText(event) {
  if (!event || typeof event !== 'object') {
    return '';
  }

  const message = event.message && typeof event.message === 'object' ? event.message : null;
  return collectTextContent(message?.content ?? event.content).join('\n').trim();
}

function isSyntheticAssistantApiImageError(event) {
  const model = getAssistantModel(event);
  if (model !== SYNTHETIC_MODEL) {
    return false;
  }

  const text = getAssistantText(event);
  return API_ERROR_PATTERN.test(text) && RECOVERABLE_IMAGE_ERROR_PATTERN.test(text);
}

function isRealAssistantEvent(event) {
  if (!isAssistantEvent(event)) {
    return false;
  }

  const model = getAssistantModel(event);
  return typeof model === 'string' && model.trim() && model.trim() !== SYNTHETIC_MODEL;
}

function analyzeClaudeSessionPoisonLines(lines, {
  maxRealAssistantSearchLines = DEFAULT_MAX_REAL_ASSISTANT_SEARCH_LINES,
} = {}) {
  const safeLines = Array.isArray(lines) ? lines : [];
  let latestAssistant = null;

  for (let index = safeLines.length - 1; index >= 0; index -= 1) {
    const parsed = safeParseJsonLine(safeLines[index]);
    if (!isAssistantEvent(parsed)) {
      continue;
    }

    latestAssistant = {
      index,
      event: parsed,
      text: getAssistantText(parsed),
      model: getAssistantModel(parsed),
    };
    break;
  }

  if (!latestAssistant || !isSyntheticAssistantApiImageError(latestAssistant.event)) {
    return {
      detected: false,
      recoverable: false,
      reason: null,
      errorText: latestAssistant?.text || null,
      syntheticLineIndex: latestAssistant?.index ?? null,
      realAssistantLineIndex: null,
      truncateLineCount: null,
    };
  }

  const maxDistance = Math.max(1, Math.floor(Number(maxRealAssistantSearchLines) || DEFAULT_MAX_REAL_ASSISTANT_SEARCH_LINES));
  const minIndex = Math.max(0, latestAssistant.index - maxDistance);
  for (let index = latestAssistant.index - 1; index >= minIndex; index -= 1) {
    const parsed = safeParseJsonLine(safeLines[index]);
    if (!isRealAssistantEvent(parsed)) {
      continue;
    }

    return {
      detected: true,
      recoverable: true,
      reason: 'image_url_unreachable',
      errorText: latestAssistant.text,
      syntheticLineIndex: latestAssistant.index,
      realAssistantLineIndex: index,
      truncateLineCount: index + 1,
    };
  }

  return {
    detected: true,
    recoverable: false,
    reason: 'image_url_unreachable',
    errorText: latestAssistant.text,
    syntheticLineIndex: latestAssistant.index,
    realAssistantLineIndex: null,
    truncateLineCount: null,
  };
}

function splitJsonlLines(raw) {
  if (typeof raw !== 'string' || raw.length === 0) {
    return [];
  }

  const lines = raw.split(/\r?\n/);
  if (lines.at(-1) === '') {
    lines.pop();
  }
  return lines;
}

function buildPoisonBackupPath(jsonlPath, now = new Date()) {
  const timestamp = now.toISOString().replace(/[:.]/g, '-');
  const basePath = `${jsonlPath}.bak-poison-${timestamp}`;
  if (!fs.existsSync(basePath)) {
    return basePath;
  }

  for (let index = 1; index < 1000; index += 1) {
    const candidate = `${basePath}-${index}`;
    if (!fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return `${basePath}-${process.pid}-${Date.now()}`;
}

function recoverClaudeSessionPoison({
  jsonlPath,
  workingDirectory,
  sessionId,
  homeDir,
  claudeProjectsDir,
  now = new Date(),
  maxRealAssistantSearchLines = DEFAULT_MAX_REAL_ASSISTANT_SEARCH_LINES,
} = {}) {
  const resolvedJsonlPath = typeof jsonlPath === 'string' && jsonlPath.trim()
    ? jsonlPath.trim()
    : resolveClaudeSessionJsonlPath({
      workingDirectory,
      sessionId,
      homeDir,
      claudeProjectsDir,
    });

  if (!resolvedJsonlPath) {
    return {
      detected: false,
      recoverable: false,
      truncated: false,
      reason: null,
      errorText: null,
      jsonlPath: null,
      backupPath: null,
      syntheticLineIndex: null,
      realAssistantLineIndex: null,
      truncateLineCount: null,
      totalLineCount: 0,
      error: 'Claude session JSONL path could not be resolved',
    };
  }

  let raw;
  try {
    raw = fs.readFileSync(resolvedJsonlPath, 'utf8');
  } catch (error) {
    return {
      detected: false,
      recoverable: false,
      truncated: false,
      reason: null,
      errorText: null,
      jsonlPath: resolvedJsonlPath,
      backupPath: null,
      syntheticLineIndex: null,
      realAssistantLineIndex: null,
      truncateLineCount: null,
      totalLineCount: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const lines = splitJsonlLines(raw);
  const analysis = analyzeClaudeSessionPoisonLines(lines, { maxRealAssistantSearchLines });
  const baseResult = {
    ...analysis,
    truncated: false,
    jsonlPath: resolvedJsonlPath,
    backupPath: null,
    totalLineCount: lines.length,
    error: null,
  };

  if (!analysis.detected || !analysis.recoverable || !Number.isInteger(analysis.truncateLineCount)) {
    return baseResult;
  }

  const backupPath = buildPoisonBackupPath(resolvedJsonlPath, now);
  fs.copyFileSync(resolvedJsonlPath, backupPath);

  const retainedLines = lines.slice(0, analysis.truncateLineCount);
  fs.writeFileSync(resolvedJsonlPath, retainedLines.length > 0 ? `${retainedLines.join('\n')}\n` : '', 'utf8');

  return {
    ...baseResult,
    truncated: true,
    backupPath,
  };
}

module.exports = {
  analyzeClaudeSessionPoisonLines,
  recoverClaudeSessionPoison,
  resolveClaudeProjectDirName,
  resolveClaudeSessionJsonlPath,
};
