import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

const MAX_SNIPPET_CHARS = 200;
const MIN_TERM_LENGTH = 4;

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function getCuratorUserPath(): string {
  const openClawHome = process.env.OPENCLAW_HOME?.trim() || path.join(homedir(), '.openclaw');
  return path.join(openClawHome, 'agents', 'curator', 'USER.md');
}

function getTopicTerms(values: string[]): Set<string> {
  const terms = new Set<string>();
  for (const value of values) {
    const normalized = value.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? [];
    for (const term of normalized) {
      if (term.length >= MIN_TERM_LENGTH) {
        terms.add(term);
      }
    }
  }
  return terms;
}

function scoreParagraph(paragraph: string, terms: Set<string>): number {
  if (terms.size === 0) {
    return 0;
  }

  const normalized = paragraph.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (normalized.includes(term)) {
      score += term.length;
    }
  }
  return score;
}

function trimSnippet(value: string): string {
  const text = normalizeText(value);
  if (text.length <= MAX_SNIPPET_CHARS) {
    return text;
  }

  return `${text.slice(0, MAX_SNIPPET_CHARS - 3).trimEnd()}...`;
}

export function getCuratorUserSnippet(input: {
  title?: unknown;
  text?: unknown;
  excerpt?: unknown;
  tags?: unknown;
  topic?: unknown;
}): string {
  let raw = '';
  try {
    raw = fs.readFileSync(getCuratorUserPath(), 'utf8');
  } catch {
    return '';
  }

  const tagText = Array.isArray(input.tags)
    ? input.tags.map(readString).filter(Boolean).join(' ')
    : '';
  const terms = getTopicTerms([
    readString(input.topic),
    readString(input.title),
    readString(input.excerpt),
    readString(input.text),
    tagText,
  ]);

  const paragraphs = raw
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map(normalizeText)
    .filter(Boolean);

  if (paragraphs.length === 0) {
    return '';
  }

  let bestParagraph = paragraphs[0];
  let bestScore = scoreParagraph(bestParagraph, terms);
  for (const paragraph of paragraphs.slice(1)) {
    const score = scoreParagraph(paragraph, terms);
    if (score > bestScore) {
      bestParagraph = paragraph;
      bestScore = score;
    }
  }

  return trimSnippet(bestParagraph);
}
