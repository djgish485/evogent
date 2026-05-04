import fs from 'node:fs';
import path from 'node:path';

const libraryRoot = path.join(process.cwd(), 'skills-library');

const registry = {
  'setup-wizard': {
    description: 'First-run onboarding and environment checks',
    sourceUrl: 'https://raw.githubusercontent.com/djgish485/evogent/main/.claude/skills/setup-wizard/SKILL.md',
  },
  'account-mirror': {
    description: 'Mirror selected Twitter accounts into the feed',
    sourceUrl: 'https://raw.githubusercontent.com/djgish485/evogent/main/skills-library/account-mirror/SKILL.md',
  },
  'full-text': {
    description: 'Experimental article full-text enrichment through current feed APIs',
    sourceUrl: 'https://raw.githubusercontent.com/djgish485/evogent/main/skills-library/full-text/SKILL.md',
  },
  'archive-import': {
    description: 'Import Twitter archive data as preference signals for curation',
    sourceUrl: 'https://raw.githubusercontent.com/djgish485/evogent/main/skills-library/archive-import/SKILL.md',
  },
  'current-event-tracker': {
    description: 'Add, modify, and retire structured current event tracking in your curation prompt',
    sourceUrl: 'https://raw.githubusercontent.com/djgish485/evogent/main/skills-library/current-event-tracker/SKILL.md',
  },
  'tweet-cache': {
    description: 'Direct-browse X/Twitter source guidance for curation using the shared browser session',
    sourceUrl: 'https://raw.githubusercontent.com/djgish485/evogent/main/skills-library/tweet-cache/SKILL.md',
  },
  'tweet-cache-bird': {
    description: 'Prefetch Bird-authenticated X/Twitter content into a local cache for deployments that explicitly choose Bird',
    sourceUrl: 'https://raw.githubusercontent.com/djgish485/evogent/main/skills-library/tweet-cache-bird/SKILL.md',
  },
  'youtube-cache': {
    description: 'Direct-browse YouTube source guidance for curation using the shared browser session',
    sourceUrl: 'https://raw.githubusercontent.com/djgish485/evogent/main/skills-library/youtube-cache/SKILL.md',
  },
  'substack-cache': {
    description: 'Direct-browse Substack source guidance for curation using the shared browser session',
    sourceUrl: 'https://raw.githubusercontent.com/djgish485/evogent/main/skills-library/substack-cache/SKILL.md',
  },
  'hackernews-cache': {
    description: 'Direct-browse Hacker News source guidance for curation using public HN surfaces',
    sourceUrl: 'https://raw.githubusercontent.com/djgish485/evogent/main/skills-library/hackernews-cache/SKILL.md',
  },
} as const;

const skillNamePattern = /^[a-z0-9-]{1,64}$/;

export interface SkillRequires {
  env?: string[];
}

export interface SkillMetadataEvogent {
  'heartbeat-task'?: boolean;
  requires?: SkillRequires;
  'feed-source'?: string;
  'feed-source-label'?: string;
}

export interface SkillMetadata {
  'evogent'?: SkillMetadataEvogent;
  [key: string]: unknown;
}

export interface SkillFrontmatter {
  name: string;
  description: string;
  'user-invocable'?: boolean;
  metadata?: SkillMetadata;
  [key: string]: unknown;
}

export interface ParsedSkill {
  frontmatter: SkillFrontmatter;
  body: string;
}

export interface InstalledSkill {
  slug: string;
  path: string;
  hasScripts: boolean;
  name: string;
  description: string;
  userInvocable: boolean;
  metadata: SkillMetadata;
  active: boolean;
}

export interface SkippedInstalledSkill {
  slug: string;
  path: string;
  error: string;
}

export interface InstallSkillInput {
  url?: string;
  registry?: string;
}

export interface InstallSkillResult {
  skill: InstalledSkill;
  source: {
    type: 'url' | 'registry';
    value: string;
  };
}

export interface ListInstalledSkillsResult {
  items: InstalledSkill[];
  skipped: SkippedInstalledSkill[];
}

function normalizeSkillMetadata(metadata: SkillFrontmatter['metadata'] | undefined): SkillMetadata {
  const normalized = { ...(metadata ?? {}) } as SkillMetadata;
  const hasLegacyMetadata = Object.prototype.hasOwnProperty.call(normalized, 'media-agent');
  const hasEvogentMetadata = Object.prototype.hasOwnProperty.call(normalized, 'evogent');

  if (hasLegacyMetadata) {
    // Transitional pre-rename install migration. Remove after legacy installed SKILL.md copies have aged out.
    if (!hasEvogentMetadata) {
      normalized.evogent = normalized['media-agent'] as SkillMetadataEvogent;
    }
    delete normalized['media-agent'];
  }

  return normalized;
}

function parseScalar(raw: string): unknown {
  const value = raw.trim();

  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;

  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
    return value.slice(1, -1);
  }

  if (value.startsWith('[') && value.endsWith(']')) {
    const body = value.slice(1, -1).trim();
    if (!body) return [];
    return body.split(',').map((item) => parseScalar(item));
  }

  if (/^-?\d+(\.\d+)?$/.test(value)) {
    return Number(value);
  }

  return value;
}

function nextContentLine(lines: string[], fromIndex: number) {
  for (let index = fromIndex; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    if (line.trim().startsWith('#')) continue;
    return {
      index,
      line,
      indent: line.match(/^ */)?.[0].length ?? 0,
      trimmed: line.trim(),
    };
  }

  return null;
}

function parseYamlSubset(input: string): Record<string, unknown> {
  const lines = input.replace(/\r\n/g, '\n').split('\n');
  const root: Record<string, unknown> = {};

  const stack: Array<{ indent: number; container: Record<string, unknown> | unknown[] }> = [
    { indent: -1, container: root },
  ];

  for (let index = 0; index < lines.length; index += 1) {
    const originalLine = lines[index];
    const trimmed = originalLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const indent = originalLine.match(/^ */)?.[0].length ?? 0;

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const parent = stack[stack.length - 1].container;

    if (trimmed.startsWith('- ')) {
      if (!Array.isArray(parent)) {
        throw new Error(`Invalid YAML list item at line ${index + 1}`);
      }
      parent.push(parseScalar(trimmed.slice(2)));
      continue;
    }

    const colonIndex = trimmed.indexOf(':');
    if (colonIndex === -1) {
      throw new Error(`Invalid YAML key-value pair at line ${index + 1}`);
    }

    const key = trimmed.slice(0, colonIndex).trim();
    const remainder = trimmed.slice(colonIndex + 1).trim();

    if (!key) {
      throw new Error(`Missing YAML key at line ${index + 1}`);
    }

    if (Array.isArray(parent)) {
      throw new Error(`Unexpected YAML key at line ${index + 1}`);
    }

    if (remainder) {
      parent[key] = parseScalar(remainder);
      continue;
    }

    const lookahead = nextContentLine(lines, index + 1);
    const isList = Boolean(lookahead && lookahead.indent > indent && lookahead.trimmed.startsWith('- '));
    const nested: Record<string, unknown> | unknown[] = isList ? [] : {};
    parent[key] = nested;
    stack.push({ indent, container: nested });
  }

  return root;
}

export function parseSkillMarkdown(content: string): ParsedSkill {
  const normalized = content.replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);

  if (!match) {
    throw new Error('SKILL.md is missing YAML frontmatter block');
  }

  const frontmatterObject = parseYamlSubset(match[1]);
  const name = typeof frontmatterObject.name === 'string' ? frontmatterObject.name.trim() : '';
  const description = typeof frontmatterObject.description === 'string' ? frontmatterObject.description.trim() : '';

  if (!name || !skillNamePattern.test(name)) {
    throw new Error('Skill frontmatter "name" is required and must be lowercase-hyphen format');
  }

  if (!description) {
    throw new Error('Skill frontmatter "description" is required');
  }

  const frontmatter: SkillFrontmatter = {
    ...frontmatterObject,
    name,
    description,
  } as SkillFrontmatter;

  const userInvocableValue = frontmatter['user-invocable'];
  if (userInvocableValue !== undefined && typeof userInvocableValue !== 'boolean') {
    throw new Error('"user-invocable" must be a boolean when provided');
  }

  if (frontmatter.metadata !== undefined && typeof frontmatter.metadata !== 'object') {
    throw new Error('"metadata" must be an object when provided');
  }

  return {
    frontmatter,
    body: match[2].trim(),
  };
}

async function ensureSkillsRoot() {
  const skillsRoot = getSkillsRoot();
  await fs.promises.mkdir(skillsRoot, { recursive: true });
}

export function getSkillsRoot(): string {
  return path.resolve(process.env.MEDIA_AGENT_SKILLS_DIR || path.join(process.cwd(), '.claude', 'skills'));
}

async function readSkillFromDisk(skillDirName: string) {
  const skillsRoot = getSkillsRoot();
  const skillDir = path.join(skillsRoot, skillDirName);
  const skillPath = path.join(skillDir, 'SKILL.md');
  const raw = await fs.promises.readFile(skillPath, 'utf8');
  const parsed = parseSkillMarkdown(raw);
  const scriptsDir = path.join(skillDir, 'scripts');

  let hasScripts = false;
  try {
    const scriptEntries = await fs.promises.readdir(scriptsDir, { withFileTypes: true });
    hasScripts = scriptEntries.some((entry) => entry.isFile());
  } catch {
    hasScripts = false;
  }

  return {
    slug: skillDirName,
    path: skillPath,
    hasScripts,
    name: parsed.frontmatter.name,
    description: parsed.frontmatter.description,
    userInvocable: parsed.frontmatter['user-invocable'] ?? false,
    metadata: normalizeSkillMetadata(parsed.frontmatter.metadata),
    active: true,
  } satisfies InstalledSkill;
}

async function resolveSkillMarkdown(input: InstallSkillInput) {
  const hasUrl = typeof input.url === 'string' && input.url.trim().length > 0;
  const hasRegistry = typeof input.registry === 'string' && input.registry.trim().length > 0;

  if (!hasUrl && !hasRegistry) {
    throw new Error('Provide either "url" or "registry"');
  }

  if (hasUrl && hasRegistry) {
    throw new Error('Provide only one install source: "url" or "registry"');
  }

  if (hasUrl) {
    throw new Error(
      'URL-based skill installation is disabled for security. Use registry-based install instead. Available: '
      + Object.keys(registry).sort().join(', ')
    );
  }

  const registryKey = input.registry!.trim().toLowerCase();
  const registryItem = registry[registryKey as keyof typeof registry];

  if (!registryItem) {
    const available = Object.keys(registry).sort().join(', ');
    throw new Error(`Unknown registry skill "${registryKey}". Available: ${available}`);
  }

  const localPath = path.join(libraryRoot, registryKey, 'SKILL.md');
  try {
    const markdown = await fs.promises.readFile(localPath, 'utf8');
    return {
      markdown,
      source: {
        type: 'registry' as const,
        value: registryKey,
      },
    };
  } catch {
    const response = await fetch(registryItem.sourceUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch registry skill "${registryKey}" from ${registryItem.sourceUrl} (${response.status})`);
    }

    return {
      markdown: await response.text(),
      source: {
        type: 'registry' as const,
        value: registryKey,
      },
    };
  }
}

async function copyRegistryScripts(registryKey: string, skillDir: string) {
  const sourceScriptsDir = path.join(libraryRoot, registryKey, 'scripts');

  try {
    const sourceEntries = await fs.promises.readdir(sourceScriptsDir, { withFileTypes: true });
    if (sourceEntries.length === 0) {
      return;
    }

    const destinationScriptsDir = path.join(skillDir, 'scripts');
    await fs.promises.mkdir(destinationScriptsDir, { recursive: true });
    await fs.promises.cp(sourceScriptsDir, destinationScriptsDir, { recursive: true, force: true });

    await Promise.all(
      sourceEntries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.sh'))
        .map(async (entry) => {
          const sourcePath = path.join(sourceScriptsDir, entry.name);
          const destinationPath = path.join(destinationScriptsDir, entry.name);
          const sourceMode = (await fs.promises.stat(sourcePath)).mode;
          await fs.promises.chmod(destinationPath, sourceMode);
        }),
    );
  } catch {
    // Some skills do not ship scripts in the library.
  }
}

export async function listInstalledSkillsWithWarnings(): Promise<ListInstalledSkillsResult> {
  await ensureSkillsRoot();
  const skillsRoot = getSkillsRoot();
  const entries = await fs.promises.readdir(skillsRoot, { withFileTypes: true });
  const skillDirs = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const results = await Promise.all(
    skillDirs.map(async (skillDirName) => {
      try {
        return { skill: await readSkillFromDisk(skillDirName), skipped: null };
      } catch (error) {
        const skillPath = path.join(skillsRoot, skillDirName, 'SKILL.md');
        return {
          skill: null,
          skipped: {
            slug: skillDirName,
            path: skillPath,
            error: error instanceof Error ? error.message : 'Failed to load skill',
          },
        };
      }
    }),
  );

  const items: InstalledSkill[] = [];
  const skipped: SkippedInstalledSkill[] = [];

  for (const result of results) {
    if (result.skill) {
      items.push(result.skill);
    }
    if (result.skipped) {
      skipped.push(result.skipped);
    }
  }

  for (const skill of skipped) {
    console.warn(`[skills] Skipping installed skill "${skill.slug}": ${skill.error}`);
  }

  return {
    items,
    skipped,
  };
}

export async function listInstalledSkills() {
  const result = await listInstalledSkillsWithWarnings();
  return result.items;
}

export async function installSkill(input: InstallSkillInput): Promise<InstallSkillResult> {
  await ensureSkillsRoot();

  const resolved = await resolveSkillMarkdown(input);
  const parsed = parseSkillMarkdown(resolved.markdown);
  const name = parsed.frontmatter.name;

  const skillsRoot = getSkillsRoot();
  const skillDir = path.join(skillsRoot, name);
  await fs.promises.mkdir(skillDir, { recursive: true });
  const skillPath = path.join(skillDir, 'SKILL.md');
  await fs.promises.writeFile(skillPath, `${resolved.markdown.replace(/\r\n/g, '\n').trim()}\n`, 'utf8');

  if (resolved.source.type === 'registry') {
    await copyRegistryScripts(resolved.source.value, skillDir);
  }

  const skills = await listInstalledSkills();
  const skill = skills.find((item) => item.name === name);

  if (!skill) {
    throw new Error(`Skill "${name}" was written but could not be loaded`);
  }

  return {
    skill,
    source: resolved.source,
  };
}

export function getSkillsRegistry(installedSlugs: Set<string> = new Set()) {
  return Object.entries(registry).map(([name, item]) => ({
    name,
    description: item.description,
    installed: installedSlugs.has(name),
  }));
}
