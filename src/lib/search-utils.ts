export interface SearchTextPart {
  text: string;
  isMatch: boolean;
}

export interface SearchSnippet {
  text: string;
  hasMatch: boolean;
}

export interface BuildSearchSnippetOptions {
  prefer?: 'first' | 'last';
}

export function tokenizeSearchQuery(search: string | null | undefined): string[] {
  if (!search) return [];

  return Array.from(new Set(
    search
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .map((token) => token.trim())
      .filter(Boolean),
  )).slice(0, 8);
}

export function escapeSqlLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

export function findFirstSearchMatch(
  text: string,
  search: string | null | undefined,
): { index: number; length: number } | null {
  const tokens = tokenizeSearchQuery(search);
  if (tokens.length === 0 || !text) {
    return null;
  }

  const normalizedText = text.toLowerCase();
  let best: { index: number; length: number } | null = null;

  for (const token of tokens) {
    const index = normalizedText.indexOf(token);
    if (index === -1) {
      continue;
    }
    if (!best || index < best.index || (index === best.index && token.length > best.length)) {
      best = { index, length: token.length };
    }
  }

  return best;
}

export function findLastSearchMatch(
  text: string,
  search: string | null | undefined,
): { index: number; length: number } | null {
  const tokens = tokenizeSearchQuery(search);
  if (tokens.length === 0 || !text) {
    return null;
  }

  const normalizedText = text.toLowerCase();
  let best: { index: number; length: number } | null = null;

  for (const token of tokens) {
    const index = normalizedText.lastIndexOf(token);
    if (index === -1) {
      continue;
    }
    if (!best || index > best.index || (index === best.index && token.length > best.length)) {
      best = { index, length: token.length };
    }
  }

  return best;
}

export function textMatchesSearchQuery(text: string | null | undefined, search: string | null | undefined): boolean {
  if (!text) return false;
  return findFirstSearchMatch(text, search) !== null;
}

export function buildSearchSnippet(
  text: string | null | undefined,
  search: string | null | undefined,
  maxLength = 180,
  options: BuildSearchSnippetOptions = {},
): SearchSnippet {
  const normalizedText = (text ?? '').replace(/\s+/g, ' ').trim();
  const safeMaxLength = Math.max(32, maxLength);
  const match = options.prefer === 'last'
    ? findLastSearchMatch(normalizedText, search)
    : findFirstSearchMatch(normalizedText, search);

  if (!match) {
    if (normalizedText.length <= safeMaxLength) {
      return { text: normalizedText, hasMatch: false };
    }
    return {
      text: `${normalizedText.slice(0, safeMaxLength - 3).trimEnd()}...`,
      hasMatch: false,
    };
  }

  if (normalizedText.length <= safeMaxLength) {
    return { text: normalizedText, hasMatch: true };
  }

  const contextLength = Math.max(12, Math.floor((safeMaxLength - match.length) / 2));
  const rawStart = Math.max(0, match.index - contextLength);
  const rawEnd = Math.min(normalizedText.length, match.index + match.length + contextLength);
  const start = rawStart > 0
    ? Math.min(normalizedText.length, rawStart + normalizedText.slice(rawStart).search(/\S/))
    : 0;
  const end = rawEnd < normalizedText.length
    ? Math.max(start, rawEnd - normalizedText.slice(0, rawEnd).split('').reverse().join('').search(/\S/))
    : normalizedText.length;
  const prefix = start > 0 ? '...' : '';
  const suffix = end < normalizedText.length ? '...' : '';
  const bodyMaxLength = safeMaxLength - prefix.length - suffix.length;
  const body = normalizedText.slice(start, end).slice(0, bodyMaxLength).trim();

  return {
    text: `${prefix}${body}${suffix}`,
    hasMatch: true,
  };
}

export function splitSearchHighlightParts(
  text: string,
  search: string | null | undefined,
): SearchTextPart[] {
  const tokens = tokenizeSearchQuery(search).sort((left, right) => right.length - left.length);
  if (tokens.length === 0 || !text) {
    return text ? [{ text, isMatch: false }] : [];
  }

  const lowerText = text.toLowerCase();
  const parts: SearchTextPart[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    let nextIndex = -1;
    let nextToken = '';

    for (const token of tokens) {
      const index = lowerText.indexOf(token, cursor);
      if (index === -1) {
        continue;
      }
      if (nextIndex === -1 || index < nextIndex || (index === nextIndex && token.length > nextToken.length)) {
        nextIndex = index;
        nextToken = token;
      }
    }

    if (nextIndex === -1) {
      parts.push({ text: text.slice(cursor), isMatch: false });
      break;
    }

    if (nextIndex > cursor) {
      parts.push({ text: text.slice(cursor, nextIndex), isMatch: false });
    }

    const matchEnd = nextIndex + nextToken.length;
    parts.push({ text: text.slice(nextIndex, matchEnd), isMatch: true });
    cursor = matchEnd;
  }

  return parts;
}
