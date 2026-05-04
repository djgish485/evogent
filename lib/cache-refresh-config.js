const fs = require('node:fs');
const path = require('node:path');

const CACHE_INTERVALS_BY_USAGE_LEVEL = Object.freeze({
  low: Object.freeze({ twitter: 60, hackernews: 120, substack: 240, youtube: 240 }),
  medium: Object.freeze({ twitter: 30, hackernews: 60, substack: 120, youtube: 120 }),
  high: Object.freeze({ twitter: 15, hackernews: 30, substack: 60, youtube: 60 }),
});
const CACHE_SOURCE_SKILLS = Object.freeze([{ skillSlug: 'tweet-cache', source: 'twitter' }, { skillSlug: 'hackernews-cache', source: 'hackernews' }, { skillSlug: 'substack-cache', source: 'substack' }, { skillSlug: 'youtube-cache', source: 'youtube' }]);

function parseIntervalMinutes(rawValue) {
  const match = typeof rawValue === 'string'
    ? rawValue.trim().toLowerCase().match(/(-?\d+(?:\.\d+)?)\s*(hours?|hrs?|hr|h|minutes?|mins?|min|m)\b/)
    : null;
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return Math.max(1, Math.floor(amount * (match[2].startsWith('h') ? 60 : 1)));
}

function extractMarkdownSection(content, heading) {
  if (typeof content !== 'string' || !content.trim()) return null;
  const lines = content.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => new RegExp(`^##\\s+${heading}\\s*$`, 'i').test(line.trim()));
  if (startIndex === -1) return null;
  const sectionLines = [];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^##\s+/.test(line.trim())) break;
    sectionLines.push(line);
  }
  return sectionLines.join('\n');
}

function normalizeUsageLevel(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'low' || normalized === 'medium' || normalized === 'high' ? normalized : null;
}

function parseConfigUsageLevel(content) {
  const section = extractMarkdownSection(content, 'Usage Level');
  return normalizeUsageLevel(section?.match(/\b(low|medium|high)\b/i)?.[1]) || 'medium';
}

function getDefaultCacheRefreshIntervals(usageLevel = 'medium') {
  return { ...CACHE_INTERVALS_BY_USAGE_LEVEL[normalizeUsageLevel(usageLevel) || 'medium'] };
}

function normalizeCacheSourceLabel(label) {
  const normalized = String(label || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
  if (!normalized) return null;
  if (['twitter', 'tweet', 'tweets', 'tweetcache', 'x', 'xcom', 'xtwitter', 'twitterx'].includes(normalized)) return 'twitter';
  if (['hackernews', 'hn'].includes(normalized)) return 'hackernews';
  if (['substack'].includes(normalized)) return 'substack';
  if (['youtube', 'yt'].includes(normalized)) return 'youtube';
  return null;
}

function parseCacheRefreshIntervals(content) {
  const section = extractMarkdownSection(content, 'Cache Intervals');
  const intervals = getDefaultCacheRefreshIntervals(parseConfigUsageLevel(content));
  if (!section) return intervals;

  for (const rawLine of section.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^[-*]\s*/, '');
    if (!line) continue;
    const match = line.match(/^([^:]+):\s*(.+)$/);
    if (!match) continue;
    const source = normalizeCacheSourceLabel(match[1]);
    const minutes = parseIntervalMinutes(match[2]);
    if (!source || minutes === null) continue;
    intervals[source] = minutes;
  }
  return intervals;
}

function readConfigUsageLevel(configPath) {
  try {
    return parseConfigUsageLevel(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return 'medium';
  }
}

function readCacheRefreshIntervals(configPath) {
  try {
    return parseCacheRefreshIntervals(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return getDefaultCacheRefreshIntervals();
  }
}

function listInstalledCacheSources(rootDir = process.cwd()) {
  const skillsRoot = path.join(rootDir, '.claude', 'skills');
  return CACHE_SOURCE_SKILLS
    .filter(({ skillSlug }) => fs.existsSync(path.join(skillsRoot, skillSlug, 'SKILL.md')))
    .map(({ source }) => source);
}

module.exports = { CACHE_SOURCE_SKILLS, getDefaultCacheRefreshIntervals, listInstalledCacheSources, parseCacheRefreshIntervals, parseConfigUsageLevel, readCacheRefreshIntervals, readConfigUsageLevel };
