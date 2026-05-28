export function normalizeThreadDisplayPart(value: string | null | undefined): string | null {
  if (!value) return null;

  const normalized = value
    .normalize('NFKC')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  return normalized || null;
}

export function getThreadDisplayGroupKey(input: {
  threadId: string;
  title?: string | null;
  subtitle?: string | null;
}): string {
  const title = normalizeThreadDisplayPart(input.title);
  const subtitle = normalizeThreadDisplayPart(input.subtitle);
  if (title) {
    if (title === 'one-offs') {
      return `display:${title}`;
    }

    return `display:${title}|${subtitle ?? ''}`;
  }

  return `id:${normalizeThreadDisplayPart(input.threadId) ?? input.threadId}`;
}

export function parseThreadFilterIds(value: string | null | undefined): string[] {
  if (!value) return [];

  const ids = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.slice(0, 200));

  return Array.from(new Set(ids));
}

export function joinThreadFilterIds(threadIds: string[]): string | null {
  const ids = Array.from(new Set(threadIds.map((entry) => entry.trim()).filter(Boolean)));
  return ids.length > 0 ? ids.join(',') : null;
}
