export const DEFAULT_AUTOMATIC_CURATION_ENABLED = true;
export const DEFAULT_BACKGROUND_SOURCE_BROWSING_ENABLED = true;

const AUTOMATIC_CURATION_SECTION_HEADING = 'Automatic Curation';
const BACKGROUND_SOURCE_BROWSING_SECTION_HEADING = 'Background Source Browsing';

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

function normalizeAutomaticCurationToken(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (['on', 'enabled', 'enable', 'true', 'yes'].includes(normalized)) {
    return true;
  }
  if (['off', 'disabled', 'disable', 'false', 'no'].includes(normalized)) {
    return false;
  }
  return DEFAULT_AUTOMATIC_CURATION_ENABLED;
}

function normalizeBackgroundSourceBrowsingToken(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (['on', 'enabled', 'enable', 'true', 'yes'].includes(normalized)) {
    return true;
  }
  if (['off', 'disabled', 'disable', 'false', 'no'].includes(normalized)) {
    return false;
  }
  return DEFAULT_BACKGROUND_SOURCE_BROWSING_ENABLED;
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

export function parseAutomaticCurationEnabled(content: string | null | undefined): boolean {
  if (typeof content !== 'string') {
    return DEFAULT_AUTOMATIC_CURATION_ENABLED;
  }

  const section = extractMarkdownSection(content, AUTOMATIC_CURATION_SECTION_HEADING);
  if (!section) {
    return DEFAULT_AUTOMATIC_CURATION_ENABLED;
  }

  const firstMeaningfulLine = section
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s*/, ''))
    .find(Boolean);

  return firstMeaningfulLine
    ? normalizeAutomaticCurationToken(firstMeaningfulLine)
    : DEFAULT_AUTOMATIC_CURATION_ENABLED;
}

export function parseBackgroundSourceBrowsingEnabled(content: string | null | undefined): boolean {
  if (typeof content !== 'string') {
    return DEFAULT_BACKGROUND_SOURCE_BROWSING_ENABLED;
  }

  const section = extractMarkdownSection(content, BACKGROUND_SOURCE_BROWSING_SECTION_HEADING);
  if (!section) {
    return DEFAULT_BACKGROUND_SOURCE_BROWSING_ENABLED;
  }

  const firstMeaningfulLine = section
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s*/, ''))
    .find(Boolean);

  return firstMeaningfulLine
    ? normalizeBackgroundSourceBrowsingToken(firstMeaningfulLine)
    : DEFAULT_BACKGROUND_SOURCE_BROWSING_ENABLED;
}

export function updateAutomaticCurationConfigContent(
  content: string,
  enabled: boolean,
): string {
  return upsertMarkdownSection(content, AUTOMATIC_CURATION_SECTION_HEADING, enabled ? 'On' : 'Off');
}

export function updateBackgroundSourceBrowsingConfigContent(
  content: string,
  enabled: boolean,
): string {
  return upsertMarkdownSection(content, BACKGROUND_SOURCE_BROWSING_SECTION_HEADING, enabled ? 'On' : 'Off');
}
