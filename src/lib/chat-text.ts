const MARKDOWNISH_LINE_PATTERN = /^(?:#{1,6}\s+\S|[-*]\s+\S|\d+\.\s+\S|>\s+\S)/;
const LABEL_PREFIXED_LINE_PATTERN = /^[A-Z][A-Za-z0-9]*(?:[ /-][A-Za-z0-9]+){0,5}:\s+\S/;

interface ChatTextNormalizationInput {
  role?: string | null;
  type?: string | null;
}

function shouldDecodeEscapedFormatting(decoded: string): boolean {
  const lines = decoded.split('\n');
  if (lines.length < 2) {
    return false;
  }

  const hasParagraphBreak = lines.some((line, index) => (
    line.trim().length === 0
    && index > 0
    && index < lines.length - 1
    && lines[index - 1]?.trim().length > 0
    && lines[index + 1]?.trim().length > 0
  ));
  if (hasParagraphBreak) {
    return true;
  }

  if (lines.some((line) => MARKDOWNISH_LINE_PATTERN.test(line.trimStart()))) {
    return true;
  }

  const labelLineCount = lines.filter((line) => LABEL_PREFIXED_LINE_PATTERN.test(line.trimStart())).length;
  return labelLineCount >= 2;
}

export function normalizeAgentChatText(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n');
  if (normalized.includes('\n') || !normalized.includes('\\n')) {
    return normalized;
  }

  const decoded = normalized.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n');
  return shouldDecodeEscapedFormatting(decoded) ? decoded : normalized;
}

export function normalizeChatMessageText(text: string, input: ChatTextNormalizationInput = {}): string {
  const normalized = text.replace(/\r\n/g, '\n');
  const type = input.type === 'agent_event' ? 'agent_event' : 'chat';
  const role = input.role === 'agent' ? 'agent' : 'user';

  if (role !== 'agent' || type !== 'chat') {
    return normalized;
  }

  return normalizeAgentChatText(normalized);
}
