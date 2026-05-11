export interface TimeZoneConfigView {
  timeZone: string;
  configuredTimeZone: string | null;
  source: 'config' | 'host' | 'utc';
  isConfigured: boolean;
  isConfiguredValid: boolean;
  warning: string | null;
}

const DEFAULT_TIME_ZONE = 'UTC';
const TIME_ZONE_SECTION_HEADING = 'Time Zone';

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

function readFirstMeaningfulLine(section: string | null): string | null {
  if (!section) return null;

  return section
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s*/, ''))
    .filter((line) => line && !/^<!--[\s\S]*-->$/.test(line))
    .find(Boolean) || null;
}

function normalizeIanaTimeZone(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return null;

  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: trimmed }).resolvedOptions().timeZone || trimmed;
  } catch {
    return null;
  }
}

function getHostTimeZone(): string | null {
  try {
    return normalizeIanaTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return null;
  }
}

export function parseTimeZoneConfig(content: string | null | undefined): TimeZoneConfigView {
  if (typeof content !== 'string') {
    const hostTimeZone = getHostTimeZone();
    return {
      timeZone: hostTimeZone || DEFAULT_TIME_ZONE,
      configuredTimeZone: null,
      source: hostTimeZone ? 'host' : 'utc',
      isConfigured: false,
      isConfiguredValid: true,
      warning: null,
    };
  }

  const configuredTimeZone = readFirstMeaningfulLine(extractMarkdownSection(content, TIME_ZONE_SECTION_HEADING));
  const normalizedConfiguredTimeZone = normalizeIanaTimeZone(configuredTimeZone);

  if (normalizedConfiguredTimeZone) {
    return {
      timeZone: normalizedConfiguredTimeZone,
      configuredTimeZone,
      source: 'config',
      isConfigured: true,
      isConfiguredValid: true,
      warning: null,
    };
  }

  const hostTimeZone = getHostTimeZone();
  const fallbackTimeZone = hostTimeZone || DEFAULT_TIME_ZONE;
  return {
    timeZone: fallbackTimeZone,
    configuredTimeZone,
    source: hostTimeZone ? 'host' : 'utc',
    isConfigured: Boolean(configuredTimeZone),
    isConfiguredValid: !configuredTimeZone,
    warning: configuredTimeZone
      ? `Invalid IANA time zone "${configuredTimeZone}". Using ${fallbackTimeZone}.`
      : null,
  };
}

export function normalizeTimeZoneConfigView(value: unknown, content: string | null | undefined): TimeZoneConfigView {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const parsedTimeZone = typeof record.timeZone === 'string' && record.timeZone.trim()
      ? record.timeZone.trim()
      : null;
    if (parsedTimeZone) {
      return {
        timeZone: parsedTimeZone,
        configuredTimeZone: typeof record.configuredTimeZone === 'string' && record.configuredTimeZone.trim()
          ? record.configuredTimeZone.trim()
          : null,
        source: record.source === 'config' || record.source === 'host' || record.source === 'utc'
          ? record.source
          : 'config',
        isConfigured: Boolean(record.isConfigured),
        isConfiguredValid: record.isConfiguredValid !== false,
        warning: typeof record.warning === 'string' && record.warning.trim()
          ? record.warning.trim()
          : null,
      };
    }
  }

  return parseTimeZoneConfig(content);
}
