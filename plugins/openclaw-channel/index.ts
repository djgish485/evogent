import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  EvogentSubmitItem,
  OpenClawChannelInput,
  OpenClawSkillOutputBundle,
} from './schema';

const skillRunsDir = process.env.OPENCLAW_SKILL_RUNS_DIR
  || path.join(os.homedir(), '.openclaw', 'data', 'skill-runs');
const evogentSubmitUrl = `${(process.env.EVOGENT_INTERNAL_BASE_URL || process.env.MEDIA_AGENT_INTERNAL_BASE_URL || 'http://127.0.0.1:3001').replace(/\/$/, '')}/api/internal/curate/submit`;

const skillColorLookup: Array<[RegExp, string]> = [
  [/competitor/i, 'rose'],
  [/email/i, 'blue'],
  [/github/i, 'purple'],
  [/research/i, 'teal'],
  [/daily[-_\s]?brief/i, 'amber'],
  [/health/i, 'green'],
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'openclaw-skill';
}

function readableSkillName(skillName: string): string {
  return skillName
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function resolveSkillName(input: OpenClawChannelInput | string): string {
  if (typeof input === 'string' && input.trim()) {
    return slugify(input);
  }

  if (!isRecord(input)) {
    throw new Error('OpenClaw Evogent channel requires a skill name.');
  }

  const skill = input.skill;
  const candidates = [
    input.skillName,
    typeof skill === 'string' ? skill : null,
    isRecord(skill) ? skill.name : null,
    isRecord(skill) ? skill.id : null,
    input.name,
    input.id,
  ];

  const candidate = candidates.find((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
  if (!candidate) {
    throw new Error('OpenClaw Evogent channel requires a skill name.');
  }
  return slugify(candidate);
}

function resolveBundleDir(input: OpenClawChannelInput | string, skillName: string): string {
  if (isRecord(input)) {
    const explicitDir = [input.bundleDir, input.outputDir, input.runDir]
      .find((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
    if (explicitDir) {
      return path.resolve(explicitDir);
    }
  }

  return path.join(skillRunsDir, skillName);
}

function normalizeTimestamp(value: unknown): string | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = new Date(value.trim());
    if (Number.isFinite(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  return null;
}

function stripHtmlForFeedText(html: string, skillName: string, runTimestamp: string): string {
  const text = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

  if (text.length >= 100) {
    return text.slice(0, 2000);
  }

  return [
    `OpenClaw MCP App output for ${readableSkillName(skillName)}.`,
    `This Evogent feed item renders the sandboxed HTML bundle emitted at ${runTimestamp}.`,
    'Open the card to inspect the same agent UI at a larger size.',
  ].join(' ');
}

async function readBundle(input: OpenClawChannelInput | string): Promise<OpenClawSkillOutputBundle> {
  const skillName = resolveSkillName(input);
  const bundleDir = resolveBundleDir(input, skillName);
  const mcpAppPath = path.join(bundleDir, 'output.mcpapp.html');
  const mcpAppStat = await fs.stat(mcpAppPath);
  if (!mcpAppStat.isFile()) {
    throw new Error(`${mcpAppPath} is not a file.`);
  }

  const mcpAppHtml = (await fs.readFile(mcpAppPath, 'utf8')).trim();
  if (!mcpAppHtml) {
    throw new Error(`${mcpAppPath} is empty.`);
  }

  const explicitTimestamp = isRecord(input)
    ? normalizeTimestamp(input.runTimestamp) ?? normalizeTimestamp(input.timestamp)
    : null;
  const runTimestamp = explicitTimestamp ?? new Date(mcpAppStat.mtimeMs).toISOString();

  return {
    skillName,
    bundleDir,
    runTimestamp,
    text: stripHtmlForFeedText(mcpAppHtml, skillName, runTimestamp),
    mcpAppHtml,
  };
}

function colorForSkill(skillName: string): string {
  return skillColorLookup.find(([pattern]) => pattern.test(skillName))?.[1] ?? 'teal';
}

function idPart(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function buildItem(bundle: OpenClawSkillOutputBundle): EvogentSubmitItem {
  const baseTitle = readableSkillName(bundle.skillName);
  const timestampId = idPart(bundle.runTimestamp);
  const baseId = `${bundle.skillName}-${timestampId}`;
  const threadId = `openclaw-${baseId}`;
  const color = colorForSkill(bundle.skillName);

  return {
    id: baseId,
    type: 'article',
    source: 'openclaw',
    sourceId: baseId,
    relationship: 'thread',
    title: baseTitle,
    text: bundle.text,
    authorDisplayName: 'OpenClaw',
    publishedAt: bundle.runTimestamp,
    tags: ['openclaw', bundle.skillName, 'mcpapp'],
    metadata: {
      layoutMode: 'agent-session',
      openClaw: {
        skillName: bundle.skillName,
        bundleDir: bundle.bundleDir,
        runTimestamp: bundle.runTimestamp,
      },
      thread: {
        threadId,
        threadTitle: baseTitle,
        color,
        continuing: true,
      },
      mcpAppHtml: bundle.mcpAppHtml,
    },
  };
}

export async function publish(input: OpenClawChannelInput | string): Promise<{
  ok: boolean;
  count: number;
  items: EvogentSubmitItem[];
  response: unknown;
}> {
  const bundle = await readBundle(input);
  const items = [buildItem(bundle)];
  const response = await fetch(evogentSubmitUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  });
  const bodyText = await response.text();
  const responseBody = bodyText ? JSON.parse(bodyText) as unknown : {};

  if (!response.ok) {
    throw new Error(`Evogent submit failed (${response.status}): ${bodyText || response.statusText}`);
  }

  return {
    ok: true,
    count: items.length,
    items,
    response: responseBody,
  };
}

export const evogentChannel = {
  name: 'evogent',
  publish,
  send: publish,
  handle: publish,
};

export default evogentChannel;
