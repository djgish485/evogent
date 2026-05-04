interface ParsedLogEventBase {
  createdAt: string;
  rawType?: string;
}

export type ParsedAgentLogEventType =
  | 'text'
  | 'tool_call'
  | 'tool_result'
  | 'completion'
  | 'system'
  | 'error';

export interface ParsedAgentLogEvent extends ParsedLogEventBase {
  type: ParsedAgentLogEventType;
  message?: string;
  toolName?: string;
  toolUseId?: string;
  isError?: boolean;
  durationMs?: number;
  details?: Record<string, unknown>;
}

export interface AgentLogOutcome {
  status: 'completed' | 'failed';
  exitCode: number | null;
  error: string | null;
}

function hasOwn(target: unknown, key: string): boolean {
  return Boolean(target && Object.prototype.hasOwnProperty.call(target, key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringifyContent(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => stringifyContent(entry)).join('\n');
  }

  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '[unserializable object]';
    }
  }

  if (value === null || value === undefined) {
    return '';
  }

  return String(value);
}

function truncateMessage(value: string, maxLength = 320): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function resolveEventTimestamp(raw: Record<string, unknown>): string {
  const candidates = [
    raw.timestamp,
    raw.createdAt,
    raw.created_at,
    raw.ts,
  ];

  for (const candidate of candidates) {
    if (typeof candidate !== 'string') {
      continue;
    }
    const date = new Date(candidate);
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString();
    }
  }

  return new Date().toISOString();
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return '';
  }

  const textBlocks: string[] = [];

  for (const block of content) {
    if (!isRecord(block)) {
      continue;
    }

    if (block.type !== 'text' || typeof block.text !== 'string') {
      continue;
    }

    const text = block.text.trim();
    if (text) {
      textBlocks.push(text);
    }
  }

  return textBlocks.join('\n').trim();
}

function extractClaudeAssistantText(entry: Record<string, unknown>): string {
  const message = entry.message;
  if (isRecord(message)) {
    const fromMessage = extractTextContent(message.content);
    if (fromMessage) {
      return fromMessage;
    }
  }

  const fromContent = extractTextContent(entry.content);
  if (fromContent) {
    return fromContent;
  }

  if (typeof entry.text === 'string') {
    return entry.text.trim();
  }

  return '';
}

function extractCodexItem(rawEvent: Record<string, unknown>): Record<string, unknown> | null {
  return isRecord(rawEvent.item) ? rawEvent.item : null;
}

function extractCodexTextValue(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => extractCodexTextValue(entry))
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  if (!isRecord(value)) {
    return '';
  }

  if (typeof value.text === 'string' && value.text.trim()) {
    return value.text.trim();
  }

  if (typeof value.message === 'string' && value.message.trim()) {
    return value.message.trim();
  }

  if (hasOwn(value, 'content')) {
    const nested = extractCodexTextValue(value.content);
    if (nested) {
      return nested;
    }
  }

  return '';
}

function extractCodexAssistantText(rawEvent: Record<string, unknown>): string {
  const item = extractCodexItem(rawEvent);
  if (!item || item.type !== 'agent_message') {
    return '';
  }

  return extractCodexTextValue(item.text ?? item.message ?? item.content);
}

function summarizeToolInput(input?: Record<string, unknown>): string | undefined {
  if (!input) {
    return undefined;
  }

  const command = typeof input.command === 'string' ? input.command.trim() : '';
  const description = typeof input.description === 'string' ? input.description.trim() : '';
  const query = typeof input.query === 'string' ? input.query.trim() : '';
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  const url = typeof input.url === 'string' ? input.url.trim() : '';
  const pathValue = typeof input.file_path === 'string'
    ? input.file_path.trim()
    : (typeof input.path === 'string' ? input.path.trim() : '');
  const pattern = typeof input.pattern === 'string' ? input.pattern.trim() : '';

  const summaryParts = [];
  if (query) summaryParts.push(query);
  if (command) summaryParts.push(command);
  if (prompt) summaryParts.push(prompt);
  if (url) summaryParts.push(url);
  if (pathValue) summaryParts.push(pathValue);
  if (pattern) summaryParts.push(pattern);
  if (description) summaryParts.push(description);

  if (summaryParts.length > 0) {
    return truncateMessage(summaryParts.join(' | '));
  }

  const fallback = stringifyContent(input);
  return fallback ? truncateMessage(fallback) : undefined;
}

function summarizeCodexCommand(item: Record<string, unknown>): string {
  if (Array.isArray(item.parsed_cmd) && item.parsed_cmd.length > 0) {
    return truncateMessage(item.parsed_cmd.join(' '), 160);
  }

  if (typeof item.command === 'string' && item.command.trim()) {
    return truncateMessage(item.command, 160);
  }

  if (typeof item.description === 'string' && item.description.trim()) {
    return truncateMessage(item.description, 160);
  }

  return '';
}

function summarizeCodexWebSearch(item: Record<string, unknown>): string {
  if (typeof item.query === 'string' && item.query.trim()) {
    return truncateMessage(item.query, 160);
  }

  const action = isRecord(item.action) ? item.action : null;
  if (typeof action?.url === 'string' && action.url.trim()) {
    return truncateMessage(action.url, 160);
  }

  return '';
}

function parseClaudeLogEvents(raw: Record<string, unknown>): ParsedAgentLogEvent[] {
  const rawType = typeof raw.type === 'string' ? raw.type : '';
  const createdAt = resolveEventTimestamp(raw);
  const events: ParsedAgentLogEvent[] = [];

  if (rawType === 'assistant') {
    const message = isRecord(raw.message) ? raw.message : null;
    const content = Array.isArray(message?.content) ? message.content : [];

    for (const entry of content) {
      if (!isRecord(entry)) continue;

      if (entry.type === 'text') {
        const text = typeof entry.text === 'string' ? entry.text.trim() : '';
        if (text) {
          events.push({
            type: 'text',
            createdAt,
            message: truncateMessage(text, 700),
            rawType,
          });
        }
      }

      if (entry.type === 'tool_use') {
        const input = isRecord(entry.input) ? entry.input : undefined;
        events.push({
          type: 'tool_call',
          createdAt,
          toolName: typeof entry.name === 'string' ? entry.name : 'unknown',
          toolUseId: typeof entry.id === 'string' ? entry.id : undefined,
          message: summarizeToolInput(input),
          rawType,
          details: input ? { input } : undefined,
        });
      }
    }

    return events;
  }

  if (rawType === 'user') {
    const message = isRecord(raw.message) ? raw.message : null;
    const content = Array.isArray(message?.content) ? message.content : [];

    for (const entry of content) {
      if (!isRecord(entry) || entry.type !== 'tool_result') {
        continue;
      }

      const messageText = truncateMessage(stringifyContent(entry.content));
      events.push({
        type: 'tool_result',
        createdAt,
        message: messageText || undefined,
        toolUseId: typeof entry.tool_use_id === 'string' ? entry.tool_use_id : undefined,
        isError: Boolean(entry.is_error),
        rawType,
      });
    }

    return events;
  }

  if (rawType === 'result') {
    const resultText = truncateMessage(stringifyContent(raw.result), 700);
    return [{
      type: 'completion',
      createdAt,
      message: resultText || undefined,
      isError: Boolean(raw.is_error),
      durationMs: typeof raw.duration_ms === 'number' ? raw.duration_ms : undefined,
      rawType,
    }];
  }

  if (rawType === 'system') {
    return [{
      type: 'system',
      createdAt,
      message: typeof raw.subtype === 'string' ? raw.subtype : 'system',
      rawType,
    }];
  }

  return events;
}

function parseCodexLogEvents(raw: Record<string, unknown>): ParsedAgentLogEvent[] {
  const rawType = typeof raw.type === 'string' ? raw.type : '';
  const createdAt = resolveEventTimestamp(raw);
  const item = extractCodexItem(raw);

  if (rawType === 'error') {
    const message = truncateMessage(extractCodexTextValue(raw.error ?? raw.message), 700);
    return [{
      type: 'error',
      createdAt,
      message: message || 'Codex task failed',
      isError: true,
      rawType,
    }];
  }

  if (rawType === 'thread.started' || rawType === 'turn.started') {
    return [{
      type: 'system',
      createdAt,
      message: rawType,
      rawType,
    }];
  }

  if (rawType === 'turn.completed') {
    return [{
      type: 'completion',
      createdAt,
      message: 'turn.completed',
      rawType,
    }];
  }

  if (!item || typeof item.type !== 'string') {
    return [];
  }

  if (rawType === 'item.started') {
    if (item.type === 'command_execution') {
      const message = summarizeCodexCommand(item);
      return [{
        type: 'tool_call',
        createdAt,
        message: message || 'Command started',
        toolName: 'command_execution',
        toolUseId: typeof item.id === 'string' ? item.id : undefined,
        rawType,
        details: {
          command: item.command,
          parsed_cmd: item.parsed_cmd,
        },
      }];
    }

    if (item.type === 'web_search') {
      const message = summarizeCodexWebSearch(item);
      return [{
        type: 'tool_call',
        createdAt,
        message: message || 'Web search started',
        toolName: 'web_search',
        toolUseId: typeof item.id === 'string' ? item.id : undefined,
        rawType,
        details: {
          query: item.query,
          action: item.action,
        },
      }];
    }

    if (item.type === 'agent_reasoning' || item.type === 'reasoning') {
      return [{
        type: 'system',
        createdAt,
        message: 'Thinking...',
        rawType,
      }];
    }

    return [];
  }

  if (rawType === 'item.completed') {
    if (item.type === 'agent_message') {
      const text = extractCodexAssistantText(raw);
      return text ? [{
        type: 'text',
        createdAt,
        message: truncateMessage(text, 700),
        rawType,
      }] : [];
    }

    if (item.type === 'command_execution') {
      const output = truncateMessage(extractCodexTextValue(item.aggregated_output ?? item.output), 700);
      const exitCode = typeof item.exit_code === 'number' ? item.exit_code : null;
      return [{
        type: 'tool_result',
        createdAt,
        message: output || (exitCode === 0 ? 'Command completed' : 'Command failed'),
        toolName: 'command_execution',
        toolUseId: typeof item.id === 'string' ? item.id : undefined,
        isError: exitCode !== null && exitCode !== 0,
        rawType,
        details: {
          exitCode,
          status: item.status,
        },
      }];
    }
  }

  return [];
}

export function extractTranscriptTextFromAgentLogEvent(raw: Record<string, unknown>): string[] {
  if (raw.type === 'assistant') {
    const text = extractClaudeAssistantText(raw);
    return text ? [text] : [];
  }

  if (raw.type === 'item.completed') {
    const text = extractCodexAssistantText(raw);
    return text ? [text] : [];
  }

  return [];
}

export function parseAgentLogEvents(raw: Record<string, unknown>): ParsedAgentLogEvent[] {
  if (raw.type === 'assistant' || raw.type === 'user' || raw.type === 'result' || raw.type === 'system') {
    return parseClaudeLogEvents(raw);
  }

  if (
    raw.type === 'thread.started'
    || raw.type === 'turn.started'
    || raw.type === 'turn.completed'
    || raw.type === 'item.started'
    || raw.type === 'item.completed'
    || raw.type === 'error'
  ) {
    return parseCodexLogEvents(raw);
  }

  return [];
}

export function inferAgentOutcomeFromLogContent(content: string): AgentLogOutcome | null {
  const lines = content.split('\n');

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) {
      continue;
    }

    let parsed: Record<string, unknown>;
    try {
      const unknownParsed = JSON.parse(line) as unknown;
      if (!isRecord(unknownParsed)) {
        continue;
      }
      parsed = unknownParsed;
    } catch {
      continue;
    }

    if (parsed.type === 'result') {
      const isError = Boolean(parsed.is_error);
      return isError
        ? {
            status: 'failed',
            exitCode: 1,
            error: truncateMessage(stringifyContent(parsed.result), 700) || 'Agent failed',
          }
        : {
            status: 'completed',
            exitCode: 0,
            error: null,
          };
    }

    if (parsed.type === 'error') {
      return {
        status: 'failed',
        exitCode: 1,
        error: truncateMessage(extractCodexTextValue(parsed.error ?? parsed.message), 700) || 'Agent failed',
      };
    }

    if (parsed.type === 'turn.completed') {
      return {
        status: 'completed',
        exitCode: 0,
        error: null,
      };
    }
  }

  return null;
}
