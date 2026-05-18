import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const defaultBaseUrl = 'http://127.0.0.1:3001';
const liveSubmitPath = '/api/internal/curate/submit';
const skillOutputFilePattern = /^output(?:\..+)?$/i;
const skillRunPreviewChars = 200;
const maxSkillRunScanDepth = 6;

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getBaseUrl() {
  return (
    process.env.EVOGENT_INTERNAL_BASE_URL
    || process.env.MEDIA_AGENT_INTERNAL_BASE_URL
    || process.env.INTERNAL_BASE_URL
    || defaultBaseUrl
  ).replace(/\/$/, '');
}

function getOpenClawHome() {
  return process.env.OPENCLAW_HOME?.trim() || path.join(os.homedir(), '.openclaw');
}

function getSkillRunsRoot() {
  return path.join(getOpenClawHome(), 'data', 'skill-runs');
}

function isPathInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeSkillNames(value) {
  if (!Array.isArray(value)) {
    return null;
  }

  const names = [];
  const seen = new Set();
  for (const item of value) {
    const name = typeof item === 'string' ? item.trim() : '';
    if (!name) {
      continue;
    }
    if (name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
      throw new Error(`Invalid skill name for evogent.skill_runs.list: ${name}`);
    }
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

function normalizeLimit(value, fallback, max) {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number(value)
      : Number.NaN;

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(1, Math.floor(parsed)));
}

function timestampMs(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.getTime();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function defaultSinceMs(hours) {
  return Date.now() - hours * 60 * 60 * 1000;
}

function parseSinceMs(value, fallbackMs, toolName) {
  if (value === undefined || value === null || value === '') {
    return fallbackMs;
  }
  const parsed = timestampMs(value);
  if (parsed === null) {
    throw new Error(`${toolName} since must be an ISO timestamp or epoch milliseconds.`);
  }
  return parsed;
}

function contentTypeForPath(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.html') || lower.endsWith('.htm')) {
    return 'html';
  }
  if (lower.endsWith('.json')) {
    return 'json';
  }
  return 'markdown';
}

function expandUserPath(filePath) {
  if (filePath === '~') {
    return os.homedir();
  }
  if (filePath.startsWith(`~${path.sep}`) || filePath.startsWith('~/')) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

async function requestJson(path, init = {}) {
  const response = await fetch(`${getBaseUrl()}${path}`, init);
  const bodyText = await response.text();
  const body = bodyText ? JSON.parse(bodyText) : {};

  if (!response.ok) {
    throw new Error(`Evogent request failed (${response.status}): ${bodyText || response.statusText}`);
  }

  return body;
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function realpathIfExists(filePath) {
  try {
    return await fs.realpath(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

async function getSkillRunSkillNames(root, skillFilter) {
  if (skillFilter) {
    return skillFilter;
  }
  if (!await pathExists(root)) {
    return [];
  }

  const entries = await fs.readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

async function collectSkillOutputFiles(directory, depth = 0) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isFile() && skillOutputFilePattern.test(entry.name)) {
      files.push(entryPath);
      continue;
    }
    if (entry.isDirectory() && depth < maxSkillRunScanDepth) {
      files.push(...await collectSkillOutputFiles(entryPath, depth + 1));
    }
  }
  return files;
}

async function resolveSkillRunReadPath(inputPath) {
  const rawPath = typeof inputPath === 'string' ? inputPath.trim() : '';
  if (!rawPath) {
    throw new Error('evogent.skill_runs.read requires a non-empty path.');
  }

  const root = getSkillRunsRoot();
  const rootReal = await realpathIfExists(root);
  const candidate = path.resolve(expandUserPath(rawPath));
  let candidateReal;
  try {
    candidateReal = await fs.realpath(candidate);
  } catch {
    throw new Error(`Skill run output does not exist: ${rawPath}`);
  }

  if (!isPathInside(rootReal, candidateReal)) {
    throw new Error('evogent.skill_runs.read path must be inside ~/.openclaw/data/skill-runs/.');
  }

  return candidateReal;
}

function toolParams(idOrParams, maybeParams) {
  return maybeParams === undefined ? idOrParams : maybeParams;
}

function textResult(value) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function requireRecordParams(value, toolName) {
  if (!isRecord(value)) {
    throw new Error(`${toolName} parameters must be a JSON object.`);
  }
  return value;
}

export async function queryBrowseCache(input = {}) {
  const params = new URLSearchParams();
  const source = typeof input.source === 'string' ? input.source.trim() : '';
  const freshAfterMs = timestampMs(input.since);
  const limit = normalizeLimit(input.limit, 100, 500);

  if (source) {
    params.set('source', source);
  }
  if (freshAfterMs !== null) {
    params.set('freshAfterMs', String(freshAfterMs));
  }
  if (input.includeExpired) {
    params.set('includeExpired', '1');
  }
  params.set('unseenFirst', input.unseenFirst === false ? '0' : '1');
  params.set('limit', String(limit));

  return requestJson(`/api/internal/browse-cache/items?${params.toString()}`);
}

export async function matchPreferences(input) {
  if (typeof input.text !== 'string' || !input.text.trim()) {
    throw new Error('evogent.preferences.match requires a non-empty text string.');
  }

  const limit = normalizeLimit(input.limit, 5, 25);
  const result = await requestJson('/api/preferences/match', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: input.text }),
  });

  if (!isRecord(result) || !Array.isArray(result.topMatches)) {
    return result;
  }

  return {
    ...result,
    topMatches: result.topMatches.slice(0, limit),
  };
}

export async function submitFeed(input) {
  const body = Array.isArray(input)
    ? { items: input }
    : requireRecordParams(input, 'evogent.feed.submit');

  if (!Array.isArray(body.items)) {
    throw new Error('evogent.feed.submit requires an items array.');
  }

  return requestJson(liveSubmitPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function recentInteractions(input = {}) {
  const params = new URLSearchParams();
  params.set('limit', String(normalizeLimit(input.limit, 50, 200)));
  return requestJson(`/api/internal/interactions/recent?${params.toString()}`);
}

export async function listSkillRuns(input = {}) {
  const params = isRecord(input) ? input : {};
  const sinceMs = parseSinceMs(params.since, defaultSinceMs(24), 'evogent.skill_runs.list');
  const root = getSkillRunsRoot();
  const rootReal = await realpathIfExists(root);
  const skillNames = await getSkillRunSkillNames(root, normalizeSkillNames(params.skills));
  const outputs = [];

  for (const skill of skillNames) {
    const skillDir = path.join(root, skill);
    const skillDirReal = await realpathIfExists(skillDir);
    if (!isPathInside(rootReal, skillDirReal) || !await pathExists(skillDirReal)) {
      continue;
    }

    const files = await collectSkillOutputFiles(skillDirReal);
    for (const filePath of files) {
      const stat = await fs.stat(filePath);
      if (!stat.isFile() || stat.mtimeMs < sinceMs) {
        continue;
      }

      let preview = '';
      try {
        preview = (await fs.readFile(filePath, 'utf8')).slice(0, skillRunPreviewChars);
      } catch {
        preview = '';
      }

      outputs.push({
        skill,
        path: filePath,
        mtime: stat.mtime.toISOString(),
        sizeBytes: stat.size,
        preview,
      });
    }
  }

  return outputs.sort((left, right) => right.mtime.localeCompare(left.mtime) || left.path.localeCompare(right.path));
}

export async function readSkillRun(input) {
  const params = requireRecordParams(input, 'evogent.skill_runs.read');
  const filePath = await resolveSkillRunReadPath(params.path);
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) {
    throw new Error('evogent.skill_runs.read path must be a file.');
  }

  return {
    path: filePath,
    content: await fs.readFile(filePath, 'utf8'),
    contentType: contentTypeForPath(filePath),
    mtime: stat.mtime.toISOString(),
  };
}

export async function searchChatHistory(input) {
  const params = requireRecordParams(input, 'evogent.chat_history.search');
  const query = typeof params.query === 'string' ? params.query.trim() : '';
  if (!query) {
    throw new Error('evogent.chat_history.search requires a non-empty query string.');
  }

  const searchParams = new URLSearchParams();
  searchParams.set('q', query);
  if (typeof params.sessionId === 'string' && params.sessionId.trim()) {
    searchParams.set('sessionId', params.sessionId.trim());
  }
  if (typeof params.since === 'string' && params.since.trim()) {
    searchParams.set('since', params.since.trim());
  }
  searchParams.set('limit', String(normalizeLimit(params.limit, 50, 200)));

  return requestJson(`/api/internal/chat-history/search?${searchParams.toString()}`);
}

const browseCacheQueryTool = {
  name: 'evogent.browse_cache.query',
  description: 'Return candidate items from Evogent browse_cache_items, optionally filtered by source and freshness.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      source: { type: 'string' },
      since: {
        anyOf: [{ type: 'string' }, { type: 'number' }],
        description: 'ISO timestamp or epoch milliseconds. When present, only fresh cache rows at or after this point are returned.',
      },
      limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
      includeExpired: { type: 'boolean', default: false },
      unseenFirst: { type: 'boolean', default: true },
    },
  },
  async execute(idOrParams, maybeParams) {
    const params = requireRecordParams(toolParams(idOrParams, maybeParams), 'evogent.browse_cache.query');
    return textResult(await queryBrowseCache({
      source: typeof params.source === 'string' ? params.source : null,
      since: params.since,
      limit: params.limit,
      includeExpired: params.includeExpired === true,
      unseenFirst: params.unseenFirst === false ? false : true,
    }));
  },
};

const preferencesMatchTool = {
  name: 'evogent.preferences.match',
  description: 'Score text against Evogent preference memory using the existing preference vector matcher.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['text'],
    properties: {
      text: { type: 'string', minLength: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 25, default: 5 },
    },
  },
  async execute(idOrParams, maybeParams) {
    const params = requireRecordParams(toolParams(idOrParams, maybeParams), 'evogent.preferences.match');
    return textResult(await matchPreferences({
      text: typeof params.text === 'string' ? params.text : '',
      limit: params.limit,
    }));
  },
};

const feedSubmitTool = {
  name: 'evogent.feed.submit',
  description: 'Submit curated feed items to Evogent live feed storage through /api/internal/curate/submit.',
  parameters: {
    type: 'object',
    additionalProperties: true,
    required: ['items'],
    properties: {
      items: {
        type: 'array',
        description: 'Feed items in the same shape accepted by /api/internal/curate/submit.',
        items: { type: 'object', additionalProperties: true },
      },
      candidates: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
      },
      cycleSummary: { type: 'object', additionalProperties: true },
      originSessionId: { type: 'string' },
    },
  },
  async execute(idOrParams, maybeParams) {
    const params = toolParams(idOrParams, maybeParams);
    return textResult(await submitFeed(params));
  },
};

const interactionsRecentTool = {
  name: 'evogent.interactions.recent',
  description: 'Return recent Evogent interaction signals joined to the corresponding feed item title and source fields.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
    },
  },
  async execute(idOrParams, maybeParams) {
    const params = toolParams(idOrParams, maybeParams);
    const input = isRecord(params)
      ? { limit: params.limit }
      : {};
    return textResult(await recentInteractions(input));
  },
};

const skillRunsListTool = {
  name: 'evogent.skill_runs.list',
  description: 'List recent OpenClaw skill output files from ~/.openclaw/data/skill-runs/ for curator consideration.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      since: {
        anyOf: [{ type: 'string' }, { type: 'number' }],
        description: 'ISO timestamp or epoch milliseconds. Defaults to 24 hours ago.',
      },
      skills: {
        type: 'array',
        description: 'Optional skill-name filter.',
        items: { type: 'string' },
      },
    },
  },
  async execute(idOrParams, maybeParams) {
    const params = toolParams(idOrParams, maybeParams);
    const input = isRecord(params) ? params : {};
    return textResult(await listSkillRuns(input));
  },
};

const skillRunsReadTool = {
  name: 'evogent.skill_runs.read',
  description: 'Read one OpenClaw skill output file from ~/.openclaw/data/skill-runs/. Rejects paths outside that directory.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['path'],
    properties: {
      path: { type: 'string', minLength: 1 },
    },
  },
  async execute(idOrParams, maybeParams) {
    const params = requireRecordParams(toolParams(idOrParams, maybeParams), 'evogent.skill_runs.read');
    return textResult(await readSkillRun(params));
  },
};

const chatHistorySearchTool = {
  name: 'evogent.chat_history.search',
  description: 'Search Evogent chat history for recent user commitments, open questions, and active discussion topics.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['query'],
    properties: {
      query: { type: 'string', minLength: 1 },
      sessionId: { type: 'string' },
      since: {
        type: 'string',
        description: 'ISO timestamp. Defaults to 14 days ago.',
      },
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
    },
  },
  async execute(idOrParams, maybeParams) {
    const params = requireRecordParams(toolParams(idOrParams, maybeParams), 'evogent.chat_history.search');
    return textResult(await searchChatHistory(params));
  },
};

export const tools = [
  browseCacheQueryTool,
  preferencesMatchTool,
  feedSubmitTool,
  interactionsRecentTool,
  skillRunsListTool,
  skillRunsReadTool,
  chatHistorySearchTool,
];

export const evogentCuratorTools = {
  id: 'evogent-curator-tools',
  name: 'Evogent Curator Tools',
  description: 'Evogent tools for the OpenClaw curator agent.',
  register(api) {
    for (const tool of tools) {
      api.registerTool(tool);
    }
  },
};

export default evogentCuratorTools;
