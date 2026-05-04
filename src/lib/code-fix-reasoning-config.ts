export type CodeFixReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const DEFAULT_CODE_FIX_REASONING_EFFORT: CodeFixReasoningEffort = 'high';

const CODE_FIX_REASONING_SECTION_HEADING = 'Code-Fix Reasoning Effort';

const VALID_VALUES: ReadonlySet<CodeFixReasoningEffort> = new Set([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

function extractMarkdownSection(content: string, heading: string): string | null {
  if (!content.trim()) {
    return null;
  }

  const lines = content.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => new RegExp(`^##\\s+${heading}\\s*$`, 'i').test(line.trim()));
  if (startIndex === -1) {
    return null;
  }

  const sectionLines: string[] = [];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^##\s+/.test(line.trim())) {
      break;
    }
    sectionLines.push(line);
  }

  return sectionLines.join('\n').trim() || null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function upsertMarkdownSection(content: string, heading: string, body: string): string {
  const normalizedContent = content.replace(/\r\n/g, '\n').trimEnd();
  const sectionPattern = new RegExp(
    `(^|\\n)##\\s+${escapeRegExp(heading)}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`,
    'i',
  );
  const nextSection = `## ${heading}\n${body.trim()}\n`;

  if (sectionPattern.test(normalizedContent)) {
    return `${normalizedContent.replace(sectionPattern, (_match, prefix) => `${prefix}${nextSection}`)}`.trimEnd() + '\n';
  }

  return `${normalizedContent}\n\n${nextSection}`.trimEnd() + '\n';
}

export function normalizeCodeFixReasoningEffort(value: string | null | undefined): CodeFixReasoningEffort {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (VALID_VALUES.has(normalized as CodeFixReasoningEffort)) {
    return normalized as CodeFixReasoningEffort;
  }
  return DEFAULT_CODE_FIX_REASONING_EFFORT;
}

export function formatCodeFixReasoningEffortLabel(value: CodeFixReasoningEffort): string {
  switch (value) {
    case 'low':
      return 'Low';
    case 'medium':
      return 'Medium';
    case 'xhigh':
      return 'XHigh';
    case 'max':
      return 'Max';
    default:
      return 'High';
  }
}

export function parseCodeFixReasoningEffort(content: string | null | undefined): CodeFixReasoningEffort {
  if (typeof content !== 'string') {
    return DEFAULT_CODE_FIX_REASONING_EFFORT;
  }

  const section = extractMarkdownSection(content, CODE_FIX_REASONING_SECTION_HEADING);
  if (!section) {
    return DEFAULT_CODE_FIX_REASONING_EFFORT;
  }

  const firstMeaningfulLine = section
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s*/, ''))
    .find(Boolean);

  return firstMeaningfulLine
    ? normalizeCodeFixReasoningEffort(firstMeaningfulLine)
    : DEFAULT_CODE_FIX_REASONING_EFFORT;
}

export function updateCodeFixReasoningEffortConfigContent(
  content: string,
  value: CodeFixReasoningEffort,
): string {
  const normalized = normalizeCodeFixReasoningEffort(value);
  return upsertMarkdownSection(
    content,
    CODE_FIX_REASONING_SECTION_HEADING,
    formatCodeFixReasoningEffortLabel(normalized),
  );
}

export const CLAUDE_CODE_FIX_REASONING_OPTIONS: ReadonlyArray<{ value: CodeFixReasoningEffort; label: string }> = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'max', label: 'Max' },
];

export const CODEX_CODE_FIX_REASONING_OPTIONS: ReadonlyArray<{ value: CodeFixReasoningEffort; label: string }> = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'XHigh' },
];

export function getCodeFixReasoningOptions(provider: 'claude' | 'codex'): ReadonlyArray<{ value: CodeFixReasoningEffort; label: string }> {
  return provider === 'codex' ? CODEX_CODE_FIX_REASONING_OPTIONS : CLAUDE_CODE_FIX_REASONING_OPTIONS;
}

export function clampCodeFixReasoningEffortToProvider(
  value: CodeFixReasoningEffort,
  provider: 'claude' | 'codex',
): CodeFixReasoningEffort {
  const options = getCodeFixReasoningOptions(provider);
  if (options.some((option) => option.value === value)) {
    return value;
  }
  if (provider === 'codex' && value === 'max') {
    return 'xhigh';
  }
  return DEFAULT_CODE_FIX_REASONING_EFFORT;
}
