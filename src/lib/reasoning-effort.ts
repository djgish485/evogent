import { type ClaudeReasoningEffort, type CodexReasoningEffort } from '@/lib/brain-provider';

export const CLAUDE_REASONING_OPTIONS: Array<{ value: ClaudeReasoningEffort; label: string }> = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'XHigh' },
  { value: 'max', label: 'Max' },
];

export const CODEX_REASONING_OPTIONS: Array<{ value: CodexReasoningEffort; label: string }> = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'XHigh' },
];

export function formatClaudeReasoningEffortLabel(value: ClaudeReasoningEffort): string {
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

export function formatCodexReasoningEffortLabel(value: CodexReasoningEffort): string {
  switch (value) {
    case 'low':
      return 'Low';
    case 'medium':
      return 'Medium';
    case 'xhigh':
      return 'XHigh';
    default:
      return 'High';
  }
}

export function extractConfigSection(content: string | null | undefined, heading: string): string {
  const match = content?.match(new RegExp(`(?:^|\\n)##\\s+${heading}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, 'i'));
  return match?.[1]?.trim() ?? '';
}

export function normalizeCodexReasoningEffortValue(value: string | null | undefined): CodexReasoningEffort | null {
  const normalized = value?.trim().toLowerCase() ?? '';
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high' || normalized === 'xhigh') {
    return normalized;
  }
  return null;
}

export function deriveCodexReasoningEffortFromConfig(content: string | null | undefined): CodexReasoningEffort {
  const explicitReasoning = normalizeCodexReasoningEffortValue(
    extractConfigSection(content, 'Codex Reasoning Effort').match(/\b(low|medium|high|xhigh)\b/i)?.[1],
  );
  if (explicitReasoning) {
    return explicitReasoning;
  }

  const usageLevel = extractConfigSection(content, 'Usage Level').match(/\b(low|medium|high)\b/i)?.[1]?.toLowerCase();
  if (usageLevel === 'low' || usageLevel === 'high') {
    return usageLevel;
  }
  return 'medium';
}
