const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_TIME_ZONE = 'UTC';
const TIME_ZONE_SECTION_HEADING = 'Time Zone';

function extractMarkdownSection(content, heading) {
  if (typeof content !== 'string' || !content.trim()) {
    return null;
  }

  const lines = content.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => new RegExp(`^##\\s+${heading}\\s*$`, 'i').test(line.trim()));
  if (startIndex === -1) {
    return null;
  }

  const sectionLines = [];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^##\s+/.test(line.trim())) {
      break;
    }
    sectionLines.push(line);
  }

  return sectionLines.join('\n').trim() || null;
}

function readFirstMeaningfulLine(section) {
  if (typeof section !== 'string') return null;

  return section
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s*/, ''))
    .filter((line) => line && !/^<!--[\s\S]*-->$/.test(line))
    .find(Boolean) || null;
}

function normalizeIanaTimeZone(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return null;

  try {
    const formatter = new Intl.DateTimeFormat('en-US', { timeZone: trimmed });
    return formatter.resolvedOptions().timeZone || trimmed;
  } catch {
    return null;
  }
}

function getHostTimeZone() {
  try {
    return normalizeIanaTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return null;
  }
}

function parseConfigTimeZone(content) {
  const section = extractMarkdownSection(content, TIME_ZONE_SECTION_HEADING);
  const configuredTimeZone = readFirstMeaningfulLine(section);
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

function readTimeZoneConfig(configPath = path.join(process.cwd(), 'data', 'config.md')) {
  try {
    return parseConfigTimeZone(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return parseConfigTimeZone('');
  }
}

function readConfiguredTimeZone(configPath = path.join(process.cwd(), 'data', 'config.md')) {
  return readTimeZoneConfig(configPath).timeZone;
}

module.exports = {
  DEFAULT_TIME_ZONE,
  TIME_ZONE_SECTION_HEADING,
  getHostTimeZone,
  normalizeIanaTimeZone,
  parseConfigTimeZone,
  readConfiguredTimeZone,
  readTimeZoneConfig,
};
