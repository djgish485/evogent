import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';

export interface FeedSkillAction {
  id: string;
  label: string;
  confirms: boolean | string;
  externalLink: boolean;
  requiresSelection: string | null;
}

interface SkillActionRegistryEntry {
  skill: string;
  skillPath: string;
  actions: FeedSkillAction[];
}

const skillNamePattern = /^[a-z0-9-]{1,64}$/;
const actionIdPattern = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

let registryCache: Map<string, SkillActionRegistryEntry> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function getSkillsRoot(): string {
  return path.resolve(process.env.MEDIA_AGENT_SKILLS_DIR || path.join(process.cwd(), '.claude', 'skills'));
}

function normalizeSkillAction(value: unknown): FeedSkillAction | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = readString(value.id).toLowerCase();
  const label = readString(value.label);
  if (!id || !actionIdPattern.test(id) || !label) {
    return null;
  }

  const confirms = typeof value.confirms === 'string' && value.confirms.trim()
    ? value.confirms.trim()
    : value.confirms === true;

  return {
    id,
    label,
    confirms,
    externalLink: value.externalLink === true,
    requiresSelection: readString(value.requiresSelection) || null,
  };
}

function readSkillActions(skillDirName: string, skillPath: string): SkillActionRegistryEntry | null {
  const raw = fs.readFileSync(skillPath, 'utf8');
  const parsed = matter(raw).data as Record<string, unknown>;
  const frontmatterName = readString(parsed.name).toLowerCase();
  const skill = frontmatterName || skillDirName;
  if (!skillNamePattern.test(skill)) {
    return null;
  }

  const metadata = isRecord(parsed.metadata) ? parsed.metadata : {};
  const evogent = isRecord(metadata.evogent) ? metadata.evogent : {};
  const actions = Array.isArray(evogent['feed-actions'])
    ? evogent['feed-actions'].map(normalizeSkillAction).filter((action): action is FeedSkillAction => Boolean(action))
    : [];

  if (actions.length === 0) {
    return null;
  }

  return {
    skill,
    skillPath,
    actions,
  };
}

function buildSkillActionRegistry(): Map<string, SkillActionRegistryEntry> {
  const registry = new Map<string, SkillActionRegistryEntry>();
  const skillsRoot = getSkillsRoot();

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(skillsRoot, { withFileTypes: true });
  } catch {
    return registry;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) {
      continue;
    }

    const skillPath = path.join(skillsRoot, entry.name, 'SKILL.md');
    try {
      const skillEntry = readSkillActions(entry.name, skillPath);
      if (skillEntry) {
        registry.set(skillEntry.skill, skillEntry);
      }
    } catch {
      // A malformed or missing skill cannot contribute feed actions.
    }
  }

  return registry;
}

function getRegistry(): Map<string, SkillActionRegistryEntry> {
  if (!registryCache) {
    registryCache = buildSkillActionRegistry();
  }
  return registryCache;
}

export function getActionsForSkill(slug: string): FeedSkillAction[] {
  const normalizedSlug = slug.trim().toLowerCase();
  if (!skillNamePattern.test(normalizedSlug)) {
    return [];
  }

  return [...(getRegistry().get(normalizedSlug)?.actions ?? [])];
}

export function getSkillAction(actionId: string): {
  skill: string;
  action: FeedSkillAction;
  skillPath: string;
} | null {
  const normalizedActionId = actionId.trim().toLowerCase();
  const separatorIndex = normalizedActionId.indexOf('.');
  if (separatorIndex <= 0) {
    return null;
  }

  const skill = normalizedActionId.slice(0, separatorIndex);
  const localActionId = normalizedActionId.slice(separatorIndex + 1);
  if (!skillNamePattern.test(skill) || !actionIdPattern.test(localActionId)) {
    return null;
  }

  const entry = getRegistry().get(skill);
  const action = entry?.actions.find((candidate) => candidate.id === localActionId);
  if (!entry || !action) {
    return null;
  }

  return {
    skill,
    action,
    skillPath: entry.skillPath,
  };
}

export function getSkillActionRegistrySnapshot(): Record<string, FeedSkillAction[]> {
  const snapshot: Record<string, FeedSkillAction[]> = {};
  for (const [skill, entry] of getRegistry()) {
    snapshot[skill] = [...entry.actions];
  }
  return snapshot;
}

export function invalidateSkillActionRegistryForTests(): void {
  registryCache = null;
}
