type JsonObject = Record<string, unknown>;

export interface BrowseCacheQueryInput {
  source?: string | null;
  since?: string | number | Date | null;
  limit?: number | string | null;
  includeExpired?: boolean;
  unseenFirst?: boolean;
}

export interface PreferenceMatchInput {
  text: string;
  limit?: number | string | null;
}

export interface FeedSubmitInput {
  items: unknown[];
  candidates?: unknown[];
  cycleSummary?: unknown;
  originSessionId?: string | null;
  origin_session_id?: string | null;
  originConversationId?: string | null;
  origin_conversation_id?: string | null;
}

export interface InteractionsRecentInput {
  limit?: number | string | null;
}

type ToolDefinition = {
  name: string;
  description: string;
  parameters: JsonObject;
  execute: (idOrParams: unknown, maybeParams?: unknown) => Promise<unknown>;
};

type PluginApi = {
  registerTool: (tool: ToolDefinition) => void;
};

const defaultBaseUrl = 'http://127.0.0.1:3001';
const shadowSubmitPath = '/api/internal/curate/shadow';

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getBaseUrl(): string {
  return (
    process.env.EVOGENT_INTERNAL_BASE_URL
    || process.env.MEDIA_AGENT_INTERNAL_BASE_URL
    || process.env.INTERNAL_BASE_URL
    || defaultBaseUrl
  ).replace(/\/$/, '');
}

function normalizeLimit(value: unknown, fallback: number, max: number): number {
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

function timestampMs(value: unknown): number | null {
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

async function requestJson(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${getBaseUrl()}${path}`, init);
  const bodyText = await response.text();
  const body = bodyText ? JSON.parse(bodyText) as unknown : {};

  if (!response.ok) {
    throw new Error(`Evogent request failed (${response.status}): ${bodyText || response.statusText}`);
  }

  return body;
}

function toolParams(idOrParams: unknown, maybeParams?: unknown): unknown {
  return maybeParams === undefined ? idOrParams : maybeParams;
}

function textResult(value: unknown) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function requireRecordParams(value: unknown, toolName: string): JsonObject {
  if (!isRecord(value)) {
    throw new Error(`${toolName} parameters must be a JSON object.`);
  }
  return value;
}

export async function queryBrowseCache(input: BrowseCacheQueryInput = {}) {
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

export async function matchPreferences(input: PreferenceMatchInput) {
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

export async function submitShadowFeed(input: FeedSubmitInput | unknown[]) {
  const body = Array.isArray(input)
    ? { items: input }
    : requireRecordParams(input, 'evogent.feed.submit');

  if (!Array.isArray(body.items)) {
    throw new Error('evogent.feed.submit requires an items array.');
  }

  return requestJson(shadowSubmitPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function recentInteractions(input: InteractionsRecentInput = {}) {
  const params = new URLSearchParams();
  params.set('limit', String(normalizeLimit(input.limit, 50, 200)));
  return requestJson(`/api/internal/interactions/recent?${params.toString()}`);
}

const browseCacheQueryTool: ToolDefinition = {
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
      since: params.since as string | number | Date | null | undefined,
      limit: params.limit as number | string | null | undefined,
      includeExpired: params.includeExpired === true,
      unseenFirst: params.unseenFirst === false ? false : true,
    }));
  },
};

const preferencesMatchTool: ToolDefinition = {
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
      limit: params.limit as number | string | null | undefined,
    }));
  },
};

const feedSubmitTool: ToolDefinition = {
  name: 'evogent.feed.submit',
  description: 'Submit curated feed items in shadow mode. This writes JSONL under data/shadow-curator-log and never inserts into the live feed.',
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
    return textResult(await submitShadowFeed(params as FeedSubmitInput | unknown[]));
  },
};

const interactionsRecentTool: ToolDefinition = {
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
      ? { limit: params.limit as number | string | null | undefined }
      : {};
    return textResult(await recentInteractions(input));
  },
};

export const tools = [
  browseCacheQueryTool,
  preferencesMatchTool,
  feedSubmitTool,
  interactionsRecentTool,
];

export const evogentCuratorTools = {
  id: 'evogent-curator-tools',
  name: 'Evogent Curator Tools',
  description: 'Shadow-mode Evogent tools for the OpenClaw curator agent.',
  register(api: PluginApi) {
    for (const tool of tools) {
      api.registerTool(tool);
    }
  },
};

export default evogentCuratorTools;
