export type SuggestionCreatorSessionTitles = Record<string, string>;

interface SuggestionCreatorItem {
  source?: string | null;
  originSessionId?: string | null;
  metadata?: Record<string, unknown> | null;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = normalizeWhitespace(value);
  return normalized || null;
}

function titleCaseSource(value: string): string {
  return value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

export function resolveSuggestionSourceCreatorLabel(source: unknown): string | null {
  const normalizedSource = normalizeOptionalString(source)?.toLowerCase() ?? null;
  if (!normalizedSource) {
    return null;
  }
  const legacyAgentSources = new Set([
    ['media', 'agent'].join('-'),
    ['media', 'agent'].join(''),
    ['media', 'agent'].join('_'),
  ]);

  switch (normalizedSource) {
    case 'enrichment':
      return 'Enrichment Agent';
    case 'chat_setup_diagnosis':
    case 'chat_setup_audit':
      return 'Setup Diagnosis';
    case 'claude':
      return 'Claude Agent';
    case 'codex':
      return 'Codex Agent';
    case 'gemini':
      return 'Gemini Agent';
    case 'chat':
      return 'Chat';
    case 'evogent':
      return 'Evo';
    default:
      if (legacyAgentSources.has(normalizedSource)) {
        return 'Evo';
      }
      return titleCaseSource(normalizedSource) || 'Evo';
  }
}

export function resolveSuggestionCreatorLabel(
  item: SuggestionCreatorItem,
  sessionTitles: SuggestionCreatorSessionTitles = {},
): string | null {
  const originSessionId = normalizeOptionalString(item.originSessionId)
    ?? normalizeOptionalString(item.metadata?.originSessionId);

  if (originSessionId) {
    const sessionTitle = normalizeOptionalString(sessionTitles[originSessionId]);
    if (sessionTitle) {
      return sessionTitle;
    }
  }

  return resolveSuggestionSourceCreatorLabel(item.source);
}
