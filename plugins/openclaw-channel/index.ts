import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  EvogentSubmitItem,
  OpenClawChannelInput,
  OpenClawSkillOutputBundle,
} from './schema';
import type { A2UINode, A2UIRenderTier } from '../../src/components/a2ui/types';

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

function isA2UINode(value: unknown): value is A2UINode {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.type === 'string';
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

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function readOptionalFile(filePath: string): Promise<string | null> {
  if (!await fileExists(filePath)) {
    return null;
  }
  const content = await fs.readFile(filePath, 'utf8');
  return content.trim() ? content : null;
}

async function readOptionalA2UI(filePath: string): Promise<A2UINode | null> {
  const content = await readOptionalFile(filePath);
  if (!content) {
    return null;
  }
  const parsed = JSON.parse(content) as unknown;
  if (!isA2UINode(parsed)) {
    throw new Error(`${filePath} must contain an A2UI root node with string id and type.`);
  }
  return parsed;
}

async function readBundle(input: OpenClawChannelInput | string): Promise<OpenClawSkillOutputBundle> {
  const skillName = resolveSkillName(input);
  const bundleDir = resolveBundleDir(input, skillName);
  const markdownPath = path.join(bundleDir, 'output.md');
  const markdownStat = await fs.stat(markdownPath);
  if (!markdownStat.isFile()) {
    throw new Error(`${markdownPath} is not a file.`);
  }

  const outputMarkdown = (await fs.readFile(markdownPath, 'utf8')).trim();
  if (!outputMarkdown) {
    throw new Error(`${markdownPath} is empty.`);
  }

  const explicitTimestamp = isRecord(input)
    ? normalizeTimestamp(input.runTimestamp) ?? normalizeTimestamp(input.timestamp)
    : null;
  const runTimestamp = explicitTimestamp ?? new Date(markdownStat.mtimeMs).toISOString();
  const uiTree = await readOptionalA2UI(path.join(bundleDir, 'output.a2ui.json'));
  const mcpAppHtml = await readOptionalFile(path.join(bundleDir, 'output.mcpapp.html'));

  return {
    skillName,
    bundleDir,
    runTimestamp,
    outputMarkdown,
    ...(uiTree ? { uiTree } : {}),
    ...(mcpAppHtml ? { mcpAppHtml } : {}),
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

function buildItem(
  bundle: OpenClawSkillOutputBundle,
  tier: A2UIRenderTier,
  index: number,
): EvogentSubmitItem {
  const baseTitle = readableSkillName(bundle.skillName);
  const timestampId = idPart(bundle.runTimestamp);
  const baseId = `${bundle.skillName}-${timestampId}`;
  const threadId = `openclaw-${baseId}`;
  const publishedAt = new Date(new Date(bundle.runTimestamp).getTime() + index).toISOString();
  const color = colorForSkill(bundle.skillName);

  return {
    id: `${baseId}-${tier}`,
    type: 'article',
    source: 'openclaw',
    sourceId: `${baseId}-${tier}`,
    relationship: 'thread',
    title: baseTitle,
    text: bundle.outputMarkdown,
    authorDisplayName: 'OpenClaw',
    publishedAt,
    tags: ['openclaw', bundle.skillName, tier],
    metadata: {
      layoutMode: 'agent-session',
      renderMarkdown: true,
      renderTier: tier,
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
      ...(tier === 'a2ui' && bundle.uiTree ? { uiTree: bundle.uiTree } : {}),
      ...(tier === 'mcpapp' && bundle.mcpAppHtml ? { mcpAppHtml: bundle.mcpAppHtml } : {}),
    },
  };
}

function buildItems(bundle: OpenClawSkillOutputBundle): EvogentSubmitItem[] {
  const tiers: A2UIRenderTier[] = ['markdown'];
  if (bundle.uiTree) {
    tiers.push('a2ui');
  }
  if (bundle.mcpAppHtml) {
    tiers.push('mcpapp');
  }
  return tiers.map((tier, index) => buildItem(bundle, tier, index));
}

export async function publish(input: OpenClawChannelInput | string): Promise<{
  ok: boolean;
  count: number;
  items: EvogentSubmitItem[];
  response: unknown;
}> {
  const bundle = await readBundle(input);
  const items = buildItems(bundle);
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
