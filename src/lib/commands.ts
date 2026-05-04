import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import commandSupport from '../../lib/chat-command-support.json';

export type CommandSource = 'project' | 'global';

export interface SlashCommandSummary {
  name: string;
  description: string;
  source: CommandSource;
}

export interface SlashCommandDocument {
  name: string;
  body: string;
  source: CommandSource;
  path: string;
}

const CODEX_SUPPORTED_COMMANDS = new Set(commandSupport.codex);

const USER_FACING_COMMAND_NAMES = new Set([
  'compare',
  'curate',
  'develop',
  'develop-claude',
  'develop-gemini',
  'develop-xhigh',
  'postmortem',
  'reflect',
  'research',
  'research-claude',
  'research-gemini',
  'review',
  'spawn-session',
  'setup-wizard',
  'status',
  'watch',
]);

interface FrontmatterObject {
  [key: string]: string | FrontmatterObject;
}

type FrontmatterValue = string | FrontmatterObject;

function parseSimpleYamlFrontmatter(content: string): FrontmatterObject {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return {};
  }

  const lines = match[1].split(/\r?\n/);
  const result: FrontmatterObject = {};
  const stack: FrontmatterObject[] = [result];
  const indentStack = [-1];

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const indent = line.search(/\S/);
    const kvMatch = line.trim().match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kvMatch) continue;

    const key = kvMatch[1];
    const value = kvMatch[2].trim();

    while (indentStack.length > 1 && indent <= indentStack[indentStack.length - 1]) {
      stack.pop();
      indentStack.pop();
    }

    const target = stack[stack.length - 1];
    if (value === '' || value === '{}') {
      target[key] = {};
      stack.push(target[key] as FrontmatterObject);
      indentStack.push(indent);
      continue;
    }

    target[key] = value.replace(/^['"]|['"]$/g, '');
  }

  return result;
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

function normalizeCommandName(name: string): string | null {
  const normalized = name.trim().toLowerCase();
  if (!/^[a-z0-9_-]+$/.test(normalized)) {
    return null;
  }
  return normalized;
}

function parseCommandDescription(content: string): string {
  const body = stripFrontmatter(content);
  const lines = body.split(/\r?\n/);
  const paragraph: string[] = [];
  let inCodeBlock = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (inCodeBlock) continue;
    if (!line) {
      if (paragraph.length > 0) break;
      continue;
    }
    if (line.startsWith('#')) {
      if (paragraph.length > 0) break;
      continue;
    }
    if (/^usage:/i.test(line) && paragraph.length === 0) {
      continue;
    }

    paragraph.push(line);
  }

  return paragraph.join(' ') || 'No description available.';
}

function isUserFacingCommand(name: string, content: string): boolean {
  const normalizedName = normalizeCommandName(name);
  if (!normalizedName) return false;

  const frontmatter = parseSimpleYamlFrontmatter(content);
  const metadata = frontmatter.metadata;
  const evogent = metadata && typeof metadata === 'object'
    ? (metadata['evogent'] as FrontmatterValue | undefined)
    : undefined;

  if (evogent && typeof evogent === 'object') {
    const hidden = evogent.hidden;
    const userFacing = evogent['user-facing'];

    if (typeof hidden === 'string' && hidden.toLowerCase() === 'true') {
      return false;
    }
    if (typeof userFacing === 'string') {
      return userFacing.toLowerCase() === 'true';
    }
  }

  return USER_FACING_COMMAND_NAMES.has(normalizedName);
}

export function resolveUserFacingCommandDocument(options: {
  commandName: string;
  cwd?: string;
  homeDir?: string;
}): SlashCommandDocument | null {
  const commandName = normalizeCommandName(options.commandName);
  if (!commandName) return null;

  const cwd = options.cwd ?? process.cwd();
  const processCwd = process.cwd();
  const homeDir = options.homeDir ?? os.homedir();
  const candidates: Array<{ filePath: string; source: CommandSource }> = [];
  const addCandidate = (filePath: string, source: CommandSource) => {
    if (candidates.some((candidate) => candidate.filePath === filePath)) return;
    candidates.push({ filePath, source });
  };

  addCandidate(path.join(cwd, '.claude', 'commands', `${commandName}.md`), 'project');
  addCandidate(path.join(processCwd, '.claude', 'commands', `${commandName}.md`), 'project');
  addCandidate(path.join(homeDir, '.claude', 'commands', `${commandName}.md`), 'global');

  for (const candidate of candidates) {
    let content: string;
    try {
      content = fs.readFileSync(candidate.filePath, 'utf8');
    } catch {
      continue;
    }

    if (!isUserFacingCommand(commandName, content)) {
      continue;
    }

    return {
      name: commandName,
      body: stripFrontmatter(content).trim(),
      source: candidate.source,
      path: candidate.filePath,
    };
  }

  return null;
}

async function readCommandDirectory(
  dirPath: string,
  source: CommandSource,
): Promise<SlashCommandSummary[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const markdownFiles = entries
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  const commands = await Promise.all(markdownFiles.map(async (fileName) => {
    const name = path.basename(fileName, '.md');
    const filePath = path.join(dirPath, fileName);
    const content = await fs.promises.readFile(filePath, 'utf8');

    if (!isUserFacingCommand(name, content)) {
      return null;
    }

    return {
      name,
      description: parseCommandDescription(content),
      source,
    } satisfies SlashCommandSummary;
  }));

  return commands.filter((command): command is SlashCommandSummary => command !== null);
}

export async function listUserFacingCommands(options: {
  cwd?: string;
  homeDir?: string;
  provider?: 'claude' | 'codex' | string;
} = {}): Promise<SlashCommandSummary[]> {
  const cwd = options.cwd ?? process.cwd();
  const homeDir = options.homeDir ?? os.homedir();
  const provider = typeof options.provider === 'string' ? options.provider.trim().toLowerCase() : 'claude';
  const directories: Array<{ dirPath: string; source: CommandSource }> = [
    { dirPath: path.join(cwd, '.claude', 'commands'), source: 'project' },
    { dirPath: path.join(homeDir, '.claude', 'commands'), source: 'global' },
  ];

  const deduped = new Map<string, SlashCommandSummary>();
  for (const directory of directories) {
    const commands = await readCommandDirectory(directory.dirPath, directory.source);
    for (const command of commands) {
      if (!deduped.has(command.name)) {
        deduped.set(command.name, command);
      }
    }
  }

  return Array.from(deduped.values())
    .filter((command) => (
      provider !== 'codex'
      || CODEX_SUPPORTED_COMMANDS.has(command.name)
    ))
    .sort((left, right) => left.name.localeCompare(right.name));
}
