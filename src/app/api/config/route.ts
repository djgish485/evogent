import fs from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import {
  CONFIG_DOCUMENT_TARGETS,
  ensureConfigTargetIntegrity,
  persistConfigContent,
  type ConfigDocumentTarget,
} from '@/lib/config-storage';
import { getDataPath } from '@/lib/data-dir';
import { enqueueOrchestratorMessage } from '@/lib/orchestrator';
import { readBrainConfig } from '../../../../lib/brain-config.js';
import { parseConfigTimeZone } from '../../../../lib/time-zone.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type ConfigTargetKey =
  | 'config'
  | 'curation-prompt'
  | 'curate-command'
  | 'reflect-command'
  | 'enrichment-instructions'
  | 'chat-instructions'
  | 'runtime-instructions'
  | 'preference-insights'
  | 'preferences'
  | 'cache-hints'
  | 'skills';

interface ConfigTarget {
  key: ConfigTargetKey;
  filePath: string;
  relativePath: string;
  historyDir: string;
  defaultContent: string;
  readOnly?: boolean;
}

interface CacheHintAccountView {
  handle: string;
  includeReplies: boolean;
}

interface CacheHintsView {
  state: 'available' | 'missing' | 'invalid';
  updatedAt: string | null;
  updatedBy: string | null;
  accounts: CacheHintAccountView[];
  searches: string[];
}

const configTarget: ConfigTarget = CONFIG_DOCUMENT_TARGETS.config;

const curationPromptTarget: ConfigTarget = CONFIG_DOCUMENT_TARGETS['curation-prompt'];

const runtimeInstructionsTarget: ConfigTarget = {
  key: 'runtime-instructions',
  filePath: path.join(process.cwd(), 'CLAUDE.md'),
  relativePath: 'CLAUDE.md',
  historyDir: '',
  defaultContent: '',
  readOnly: true,
};

const curateCommandTarget: ConfigTarget = {
  key: 'curate-command',
  filePath: path.join(process.cwd(), '.claude', 'commands', 'curate.md'),
  relativePath: '.claude/commands/curate.md',
  historyDir: '',
  defaultContent: '# Curate command not found',
  readOnly: true,
};

const reflectCommandTarget: ConfigTarget = {
  key: 'reflect-command',
  filePath: path.join(process.cwd(), '.claude', 'commands', 'reflect.md'),
  relativePath: '.claude/commands/reflect.md',
  historyDir: '',
  defaultContent: '# Reflect command not found',
  readOnly: true,
};

const enrichmentInstructionsTarget: ConfigTarget = {
  key: 'enrichment-instructions',
  filePath: path.join(process.cwd(), '.claude', 'commands', 'intake-enrich.md'),
  relativePath: '.claude/commands/intake-enrich.md + src/app/api/feed/[id]/enrich/route.ts',
  historyDir: '',
  defaultContent: '# Enrichment instructions not found',
  readOnly: true,
};

const chatInstructionsTarget: ConfigTarget = {
  key: 'chat-instructions',
  filePath: path.join(process.cwd(), 'CLAUDE.md'),
  relativePath: 'CLAUDE.md',
  historyDir: '',
  defaultContent: '',
  readOnly: true,
};

const preferenceInsightsTarget: ConfigTarget = {
  key: 'preference-insights',
  filePath: getDataPath('preference-insights.md'),
  relativePath: 'data/preference-insights.md',
  historyDir: '',
  defaultContent: '# No preference insights yet\n\nReflection will synthesize long-term preference patterns here.',
  readOnly: true,
};

const preferencesTarget: ConfigTarget = {
  key: 'preferences',
  filePath: getDataPath('preferences-context.md'),
  relativePath: 'data/preferences-context.md',
  historyDir: '',
  defaultContent: '# No preferences learned yet\n\nInteract with feed items (thumbs up/down) to build preferences.',
  readOnly: true,
};

const cacheHintsTarget: ConfigTarget = {
  key: 'cache-hints',
  filePath: getDataPath('cache-hints.json'),
  relativePath: 'data/cache-hints.json',
  historyDir: '',
  defaultContent: '',
  readOnly: true,
};

const skillsTarget: ConfigTarget = {
  key: 'skills',
  filePath: '',
  relativePath: '.claude/skills/',
  historyDir: '',
  defaultContent: '# No skills installed',
  readOnly: true,
};

const TARGETS_BY_KEY: Record<ConfigTargetKey, ConfigTarget> = {
  config: configTarget,
  'curation-prompt': curationPromptTarget,
  'curate-command': curateCommandTarget,
  'reflect-command': reflectCommandTarget,
  'enrichment-instructions': enrichmentInstructionsTarget,
  'chat-instructions': chatInstructionsTarget,
  'runtime-instructions': runtimeInstructionsTarget,
  'preference-insights': preferenceInsightsTarget,
  preferences: preferencesTarget,
  'cache-hints': cacheHintsTarget,
  skills: skillsTarget,
};

const INVALID_TARGET_ERROR = 'Invalid target. Use config, curation-prompt, curate-command, reflect-command, enrichment-instructions, chat-instructions, runtime-instructions, preference-insights, preferences, cache-hints, or skills.';
const backgroundJobsDisabled = process.env.MEDIA_AGENT_DISABLE_BACKGROUND_JOBS === '1';
const ENRICHMENT_INSTRUCTIONS_HEADER = `# Enrichment Instructions

## Intake Enrichment (deterministic)`;

function buildChatInstructionsHeader() {
  const brainConfig = readBrainConfig(getDataPath('config.md'));
  const runtimeLine = brainConfig.provider === 'codex'
    ? 'The inline chat agent runs as an ephemeral `codex exec --json` task with session continuity.'
    : 'The inline chat agent runs as an ephemeral `claude -p` process with session continuity.';
  const modelLine = brainConfig.provider === 'codex'
    ? `**Model:** ${brainConfig.codexModel} (${brainConfig.codexReasoningEffort} reasoning)`
    : '**Model:** Claude Opus 4.7';
  const sessionLine = brainConfig.provider === 'codex'
    ? '**Session:** Persistent per conversation via `codex exec resume`'
    : '**Session:** Persistent per conversation via `--resume`';

  return `# Chat Agent Instructions

${runtimeLine}
Each message resumes the prior session, giving the agent memory of the conversation.

${modelLine}
**Priority:** Highest (400) - chat tasks always run before curation, enrichment, etc.
${sessionLine}
**Task prompt:** Built from \`buildTaskPrompt()\` and \`buildChatInstruction()\`, including the user message, \`ChatMessageId\`, optional \`InReplyTo\` / \`Context\`, and orchestrator metadata.
**Context files read at runtime:** config.md, curation-prompt.md, preferences-context.md, preference-insights.md
**Personal config edits:** Exact user-owned settings in gitignored \`data/config.md\` may be edited directly; tracked source/docs/code and broader product behavior changes still go through \`code_fix\`.

---`;
}

function buildEnrichmentAgentHeader() {
  const brainConfig = readBrainConfig(getDataPath('config.md'));
  const runtimeLabel = brainConfig.provider === 'codex'
    ? 'a Codex CLI task'
    : 'a claude -p agent';

  return `## Post Detail Enrichment (agent-based)
The following prompt is sent to ${runtimeLabel} when you click into a post:`;
}

function extractMarkdownSectionUntilNextTopLevelHeader(content: string, heading: string) {
  const lines = content.split('\n');
  const startIndex = lines.findIndex((line) => line.trim() === heading);
  if (startIndex === -1) {
    return null;
  }

  let endIndex = lines.length;
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    if (lines[index]?.startsWith('## ')) {
      endIndex = index;
      break;
    }
  }

  return lines.slice(startIndex, endIndex).join('\n').trim();
}

function normalizeTargetParam(value: string | null): ConfigTargetKey | null {
  if (!value) return 'config';

  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === 'config' || normalized === 'settings' || normalized === 'data/config.md') {
    return 'config';
  }

  if (
    normalized === 'curation-prompt'
    || normalized === 'curation_prompt'
    || normalized === 'curation'
    || normalized === 'prompt'
    || normalized === 'data/curation-prompt.md'
  ) {
    return 'curation-prompt';
  }

  if (
    normalized === 'curate-command'
    || normalized === 'curate_command'
    || normalized === 'curate'
    || normalized === '.claude/commands/curate.md'
  ) {
    return 'curate-command';
  }

  if (
    normalized === 'reflect-command'
    || normalized === 'reflect_command'
    || normalized === 'reflect'
    || normalized === '.claude/commands/reflect.md'
  ) {
    return 'reflect-command';
  }

  if (
    normalized === 'enrichment-instructions'
    || normalized === 'enrichment_instructions'
    || normalized === 'enrichment'
    || normalized === 'enrich'
    || normalized === 'intake-enrich'
    || normalized === 'intake_enrich'
    || normalized === '.claude/commands/intake-enrich.md'
    || normalized === 'src/app/api/feed/[id]/enrich/route.ts'
  ) {
    return 'enrichment-instructions';
  }

  if (
    normalized === 'runtime-instructions'
    || normalized === 'runtime_instructions'
    || normalized === 'runtime'
    || normalized === 'instructions'
    || normalized === 'claude.md'
    || normalized === 'claude'
  ) {
    return 'runtime-instructions';
  }

  if (
    normalized === 'chat-instructions'
    || normalized === 'chat_instructions'
    || normalized === 'chatinstructions'
    || normalized === 'chat'
  ) {
    return 'chat-instructions';
  }

  if (
    normalized === 'preference-insights'
    || normalized === 'preference_insights'
    || normalized === 'preference-insight'
    || normalized === 'insights'
    || normalized === 'insight'
    || normalized === 'data/preference-insights.md'
  ) {
    return 'preference-insights';
  }

  if (
    normalized === 'preferences'
    || normalized === 'preference'
    || normalized === 'preferences-context'
    || normalized === 'preferences_context'
    || normalized === 'data/preferences-context.md'
  ) {
    return 'preferences';
  }

  if (
    normalized === 'cache-hints'
    || normalized === 'cache_hints'
    || normalized === 'cache'
    || normalized === 'hints'
    || normalized === 'data/cache-hints.json'
  ) {
    return 'cache-hints';
  }

  if (
    normalized === 'skills'
    || normalized === '.claude/skills'
    || normalized === '.claude/skills/'
  ) {
    return 'skills';
  }

  return null;
}

function resolveTarget(request: Request): ConfigTarget | null {
  const { searchParams } = new URL(request.url);
  const targetParam = searchParams.get('target') ?? searchParams.get('file');
  const targetKey = normalizeTargetParam(targetParam);
  if (!targetKey) {
    return null;
  }
  return TARGETS_BY_KEY[targetKey];
}

async function loadSkillsContent() {
  const skillsDir = path.join(process.cwd(), '.claude', 'skills');
  let combined = '';

  try {
    const entries = await fs.promises.readdir(skillsDir, { withFileTypes: true });
    const skillNames = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));

    for (const skillName of skillNames) {
      const skillPath = path.join(skillsDir, skillName, 'SKILL.md');
      try {
        const skillContent = await fs.promises.readFile(skillPath, 'utf8');
        combined += `---\n## Skill: ${skillName}\n\n${skillContent}\n\n`;
      } catch {
        // Skip missing or unreadable SKILL.md files.
      }
    }
  } catch {
    // Skills directory does not exist.
  }

  return combined || skillsTarget.defaultContent;
}

function normalizeCacheHintHandle(value: unknown) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim().replace(/^@+/, '');
  return trimmed || null;
}

async function loadCacheHintsView(target: ConfigTarget): Promise<{ content: string; cacheHints: CacheHintsView }> {
  let raw = '';

  try {
    raw = await fs.promises.readFile(target.filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        content: '',
        cacheHints: {
          state: 'missing',
          updatedAt: null,
          updatedBy: null,
          accounts: [],
          searches: [],
        },
      };
    }

    throw error;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Cache hints must be an object');
    }

    const record = parsed as Record<string, unknown>;
    const accounts = Array.isArray(record.accounts)
      ? record.accounts.flatMap((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          return [];
        }

        const handle = normalizeCacheHintHandle((entry as Record<string, unknown>).handle);
        if (!handle) {
          return [];
        }

        return [{
          handle,
          includeReplies: Boolean((entry as Record<string, unknown>).includeReplies),
        }];
      })
      : [];

    const searches = Array.isArray(record.searches)
      ? record.searches
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter(Boolean)
      : [];

    return {
      content: raw,
      cacheHints: {
        state: 'available',
        updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt.trim() || null : null,
        updatedBy: typeof record.updatedBy === 'string' ? record.updatedBy.trim() || null : null,
        accounts,
        searches,
      },
    };
  } catch {
    return {
      content: raw,
      cacheHints: {
        state: 'invalid',
        updatedAt: null,
        updatedBy: null,
        accounts: [],
        searches: [],
      },
    };
  }
}

async function loadChatInstructionsContent() {
  const claudeContent = await fs.promises.readFile(chatInstructionsTarget.filePath, 'utf8');
  const chatSchemaSection = extractMarkdownSectionUntilNextTopLevelHeader(claudeContent, '## Chat JSONL Schema');
  const chatArchitectureSection = extractMarkdownSectionUntilNextTopLevelHeader(claudeContent, '### Chat Architecture Awareness');

  const extractedSections = [
    chatSchemaSection,
    chatArchitectureSection && !chatSchemaSection?.includes('### Chat Architecture Awareness')
      ? chatArchitectureSection
      : null,
  ].filter((section): section is string => Boolean(section));

  if (extractedSections.length === 0) {
    return `${buildChatInstructionsHeader()}\n\nUnable to extract chat-specific sections from \`CLAUDE.md\`.`;
  }

  return [buildChatInstructionsHeader(), ...extractedSections].join('\n\n');
}

function extractStringLiterals(serializedArray: string) {
  const matches = serializedArray.match(/'(?:\\[\s\S]|[^'])*'|"(?:\\[\s\S]|[^"])*"|`(?:\\[\s\S]|[^`])*`/g);
  return matches ?? [];
}

function decodePromptLiteral(literal: string) {
  const quote = literal[0];
  let decoded = literal.slice(1, -1);

  decoded = decoded
    .replace(/\\r/g, '\r')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\\\/g, '\\');

  if (quote === '\'') {
    return decoded.replace(/\\'/g, '\'').replace(/\\"/g, '"');
  }

  if (quote === '"') {
    return decoded.replace(/\\"/g, '"').replace(/\\'/g, '\'');
  }

  return decoded.replace(/\\`/g, '`');
}

function extractJoinedPromptArray(source: string, functionName = 'buildEnrichmentPrompt') {
  const functionStart = source.indexOf(`function ${functionName}`);
  if (functionStart === -1) {
    return null;
  }

  const returnStart = source.indexOf('return [', functionStart);
  if (returnStart === -1) {
    return null;
  }

  const arrayStart = source.indexOf('[', returnStart);
  const arrayEnd = source.indexOf("].join('\\n');", arrayStart);
  if (arrayStart === -1 || arrayEnd === -1) {
    return null;
  }

  const serializedArray = source.slice(arrayStart + 1, arrayEnd);
  const literals = extractStringLiterals(serializedArray);
  if (literals.length === 0) {
    return null;
  }

  return literals.map(decodePromptLiteral).join('\n').trim();
}

function extractFunctionStringLiterals(source: string, functionName: string) {
  const functionStart = source.indexOf(`function ${functionName}`);
  if (functionStart === -1) {
    return null;
  }

  const nextFunctionStart = source.indexOf('\nfunction ', functionStart + 1);
  const nextExportedFunctionStart = source.indexOf('\nexport function ', functionStart + 1);
  const sectionEndCandidates = [nextFunctionStart, nextExportedFunctionStart]
    .filter((candidate) => candidate >= 0);
  const sectionEnd = sectionEndCandidates.length > 0
    ? Math.min(...sectionEndCandidates)
    : source.length;

  const body = source.slice(functionStart, sectionEnd);
  const literals = extractStringLiterals(body);
  if (literals.length === 0) {
    return null;
  }

  return literals.map(decodePromptLiteral).join('\n').trim();
}

function extractEnrichmentPromptSnapshot(sources: string[]) {
  const sections = [
    extractJoinedPromptArray(sources[0] || '', 'buildEnrichmentPrompt'),
    extractFunctionStringLiterals(sources[1] || '', 'buildEnrichmentPrompt'),
    extractFunctionStringLiterals(sources[1] || '', 'buildTweetStepInstructions'),
    extractFunctionStringLiterals(sources[1] || '', 'buildBrowserTweetInstructions'),
    extractFunctionStringLiterals(sources[1] || '', 'buildBirdTweetInstructions'),
    extractFunctionStringLiterals(sources[1] || '', 'buildQuotedTweetContext'),
  ].filter((section): section is string => typeof section === 'string' && section.trim().length > 0);

  if (sections.length === 0) {
    return null;
  }

  return sections.join('\n');
}

async function loadGeneratedReadOnlyContent(target: ConfigTarget) {
  switch (target.key) {
    case 'chat-instructions':
      return loadChatInstructionsContent();
    case 'enrichment-instructions': {
      const [intakeContent, enrichRouteSource, enrichPromptHelperSource] = await Promise.all([
        fs.promises.readFile(target.filePath, 'utf8'),
        fs.promises.readFile(path.join(process.cwd(), 'src', 'app', 'api', 'feed', '[id]', 'enrich', 'route.ts'), 'utf8'),
        fs.promises.readFile(path.join(process.cwd(), 'src', 'lib', 'feed-enrichment-prompt.ts'), 'utf8').catch(() => ''),
      ]);
      const extractedPrompt = extractEnrichmentPromptSnapshot([enrichRouteSource, enrichPromptHelperSource])
        ?? 'Unable to extract the inline enrichment prompt from `buildEnrichmentPrompt()`.';

      return [
        ENRICHMENT_INSTRUCTIONS_HEADER,
        intakeContent.trim(),
        buildEnrichmentAgentHeader(),
        extractedPrompt,
      ].join('\n\n');
    }
    default:
      return null;
  }
}

export async function GET(request: Request) {
  const target = resolveTarget(request);
  if (!target) {
    return NextResponse.json({ error: INVALID_TARGET_ERROR }, { status: 400 });
  }

  if (target.key === 'cache-hints') {
    const { content, cacheHints } = await loadCacheHintsView(target);
    return NextResponse.json({
      content,
      cacheHints,
      target: target.key,
      path: target.relativePath,
      readOnly: true,
    });
  }

  if (target.key === 'skills') {
    const content = await loadSkillsContent();
    return NextResponse.json({
      content,
      target: target.key,
      path: target.relativePath,
      readOnly: true,
    });
  }

  let content = target.defaultContent;
  let editableIntegrity: Awaited<ReturnType<typeof ensureConfigTargetIntegrity>> | null = null;
  if (target.readOnly) {
    const generatedContent = await loadGeneratedReadOnlyContent(target);
    if (generatedContent !== null) {
      content = generatedContent;
    } else {
      try {
        content = await fs.promises.readFile(target.filePath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    }
  } else {
    const repairResult = await ensureConfigTargetIntegrity(target as ConfigDocumentTarget);
    if (!repairResult.ok) {
      return NextResponse.json({
        error: repairResult.message,
        integrity: repairResult.integrity,
      }, { status: 500 });
    }
    editableIntegrity = repairResult;
    content = repairResult.content;
  }

  const timeZone = target.key === 'config' ? parseConfigTimeZone(content) : null;

  return NextResponse.json({
    content,
    target: target.key,
    path: target.relativePath,
    readOnly: target.readOnly ?? false,
    ...(timeZone ? { timeZone } : {}),
    ...(!target.readOnly && (target.key === 'config' || target.key === 'curation-prompt')
      ? { integrity: editableIntegrity?.integrity ?? null }
      : {}),
  });
}

export async function POST(request: Request) {
  const target = resolveTarget(request);
  if (!target) {
    return NextResponse.json({ error: INVALID_TARGET_ERROR }, { status: 400 });
  }

  if (target.readOnly) {
    return NextResponse.json({ error: 'This config is read-only' }, { status: 403 });
  }

  if (target.key !== 'config' && target.key !== 'curation-prompt') {
    return NextResponse.json({ error: INVALID_TARGET_ERROR }, { status: 400 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
  }

  const content = typeof (payload as { content?: unknown }).content === 'string'
    ? (payload as { content: string }).content
    : null;

  if (content === null) {
    return NextResponse.json({ error: 'content must be a string' }, { status: 400 });
  }

  const writeResult = await persistConfigContent({
    target: target as ConfigDocumentTarget,
    content,
    source: 'manual_edit',
  });
  if (!writeResult.ok) {
    return NextResponse.json({
      error: writeResult.message,
      integrity: writeResult.integrity,
    }, { status: writeResult.statusCode });
  }

  let queuedForBrain = false;
  if (!backgroundJobsDisabled) {
    try {
      const result = await enqueueOrchestratorMessage({
        message: `Config updated. Re-read ${target.relativePath}.`,
        priority: 'post_enrichment',
        source: 'manual_edit',
        metadata: {
          endpoint: '/api/config',
          target: target.key,
          path: target.relativePath,
        },
      });
      queuedForBrain = result.ok;
    } catch (error) {
      console.warn('[config] failed to queue config update notification', error);
    }
  }

  return NextResponse.json({
    ok: true,
    changed: writeResult.changed,
    queuedForBrain,
    target: target.key,
    path: target.relativePath,
    ...(target.key === 'config' ? { timeZone: parseConfigTimeZone(content) } : {}),
    ...(writeResult.snapshot ? { snapshot: writeResult.snapshot } : {}),
    integrity: writeResult.integrity,
  });
}
