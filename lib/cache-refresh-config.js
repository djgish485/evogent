const fs = require('node:fs');
const path = require('node:path');

const CACHE_SOURCE_SKILLS = Object.freeze([{ skillSlug: 'tweet-cache', source: 'twitter' }, { skillSlug: 'hackernews-cache', source: 'hackernews' }, { skillSlug: 'substack-cache', source: 'substack' }, { skillSlug: 'youtube-cache', source: 'youtube' }]);

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

function readConfigUsageLevel(configPath) {
  try {
    return parseConfigUsageLevel(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return 'medium';
  }
}

function listInstalledCacheSources(rootDir = process.cwd()) {
  const skillsRoot = path.join(rootDir, '.claude', 'skills');
  return CACHE_SOURCE_SKILLS
    .filter(({ skillSlug }) => fs.existsSync(path.join(skillsRoot, skillSlug, 'SKILL.md')))
    .map(({ source }) => source);
}

function hasCuratorChatSession(dbPath) {
  try {
    const db = require('better-sqlite3')(dbPath, { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare("SELECT 1 FROM chat_sessions WHERE session_type = 'curator' LIMIT 1").get();
      return Boolean(row);
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

function resolveCurationCapabilityDbPath(rootDir) {
  const testServerDataDir = typeof process.env.TEST_SERVER_DATA_DIR === 'string' && process.env.TEST_SERVER_DATA_DIR.trim()
    ? process.env.TEST_SERVER_DATA_DIR.trim()
    : '';
  if (testServerDataDir) {
    return path.join(path.resolve(testServerDataDir), 'media-agent.db');
  }

  if (typeof process.env.MEDIA_AGENT_DB_PATH === 'string' && process.env.MEDIA_AGENT_DB_PATH.trim()) {
    return process.env.MEDIA_AGENT_DB_PATH;
  }

  const dataDir = process.env.DATA_DIR || path.join(rootDir, 'data');
  return path.join(path.resolve(dataDir), 'media-agent.db');
}

function hasCurationCapability(rootDir = process.cwd()) {
  if (listInstalledCacheSources(rootDir).length > 0) return true;
  return hasCuratorChatSession(resolveCurationCapabilityDbPath(rootDir));
}

module.exports = { CACHE_SOURCE_SKILLS, hasCurationCapability, hasCuratorChatSession, listInstalledCacheSources, parseConfigUsageLevel, readConfigUsageLevel };
