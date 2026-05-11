import fs from 'node:fs';
import path from 'node:path';
import { resolveUserFacingCommandDocument } from '@/lib/commands';
import { readPromptAddon, renderPromptAddonBody } from '../../lib/prompt-addons';
import {
  UNTRUSTED_CONTENT_PROMPT_PRELUDE,
  createPromptSafetyNonce,
  wrapUntrustedContent,
} from '../../lib/prompt-safety.js';
import { readTimeZoneConfig } from '../../lib/time-zone.js';

const POST_CONTEXT_SEPARATOR = '\n\nContext — discussing this post:';

function readInstructionDocument(relativePath: string, fallback: string): string {
  try {
    return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8').trim() || fallback;
  } catch {
    return fallback;
  }
}

function getSlashCommandName(message: string): string | null {
  const match = message.trim().match(/^\/([A-Za-z0-9_-]+)/);
  return match?.[1]?.trim().toLowerCase() || null;
}

function splitPostContext(message: string): { message: string; postContext: string | null } {
  const separatorIndex = message.indexOf(POST_CONTEXT_SEPARATOR);
  if (separatorIndex === -1) {
    return { message, postContext: null };
  }

  const trustedMessage = message.slice(0, separatorIndex).trimEnd();
  const postContext = message.slice(separatorIndex + POST_CONTEXT_SEPARATOR.length).trim();
  return {
    message: trustedMessage || message,
    postContext: postContext || null,
  };
}

function buildSlashCommandInstructionBlock(input: {
  message: string;
  cwd?: string;
  homeDir?: string;
}): string[] {
  const commandName = getSlashCommandName(input.message);
  if (!commandName) return [];

  const commandDocument = resolveUserFacingCommandDocument({
    commandName,
    cwd: input.cwd,
    homeDir: input.homeDir,
  });
  if (!commandDocument) return [];

  return [
    `The user invoked /${commandDocument.name}. Follow the matching command document below for this turn.`,
    `CommandDocumentPath: ${path.relative(input.cwd ?? process.cwd(), commandDocument.path) || commandDocument.path}`,
    '',
    `## Slash Command Document: /${commandDocument.name}`,
    commandDocument.body,
  ];
}

function buildSharedChatEnvelope(input: {
  message: string;
  context: string | null;
  inReplyTo: string | null;
  messageId: string;
  sessionId: string;
  attachmentPaths?: string[];
}): string[] {
  const splitMessage = splitPostContext(input.message);
  const nonce = splitMessage.postContext ? createPromptSafetyNonce() : null;
  const contextText = input.context ? ` Context: ${input.context}` : '';
  const replyTargetText = input.inReplyTo ? ` InReplyTo: ${input.inReplyTo}` : '';
  const attachmentLines = (input.attachmentPaths ?? []).map((filePath) => `[Attached file: ${filePath}]`);
  const postContextBlock = splitMessage.postContext && nonce
    ? [
        'Context - discussing this post:',
        wrapUntrustedContent(splitMessage.postContext, 'feed-context', nonce),
      ].join('\n')
    : null;

  return [
    ...attachmentLines,
    splitMessage.postContext ? UNTRUSTED_CONTENT_PROMPT_PRELUDE : null,
    `Chat: ${splitMessage.message}`,
    `ChatMessageId: ${input.messageId}`,
    `SessionId: ${input.sessionId}`,
    `${replyTargetText}${contextText}`.trim(),
    postContextBlock,
  ].filter((line): line is string => Boolean(line));
}

export function buildChatInstruction(input: {
  message: string;
  context: string | null;
  inReplyTo: string | null;
  messageId: string;
  sessionId: string;
  attachmentPaths?: string[];
  cwd?: string;
  homeDir?: string;
}): string {
  const cwd = input.cwd ?? process.cwd();
  const chatAddon = readPromptAddon(cwd, '.claude/chat-addon.md');
  const chatAddonBody = renderPromptAddonBody(chatAddon.body, { sessionId: input.sessionId });

  return [
    ...buildSharedChatEnvelope(input),
    ...buildSlashCommandInstructionBlock(input),
    'Respond by POSTing exactly one JSON body to $MEDIA_AGENT_INTERNAL_BASE_URL/api/internal/chat/submit. Do not write chat-output.jsonl directly.',
    'Submit {"type":"chat","id":"chat-...","role":"agent","inReplyTo":"' + input.messageId + '","text":"...","taskId":"$MEDIA_AGENT_TASK_ID","timestamp":"ISO8601"}.',
    `Your working directory is ${cwd}. Any code_fix suggestion you author from this chat will be dispatched to a dev agent running in exactly that directory. Every metadata.targetFiles entry and every file path mentioned inside metadata.proposedValue must be inside ${cwd}. When authoring code_fix targetFiles, do not harvest candidate files by running rg, find, ls, or sed against /root, /, or sibling repos. Examples returned by GET $MEDIA_AGENT_INTERNAL_BASE_URL/api/feed are schema illustrations, not target templates; they come from /root/evogent and apply only when this chat's working directory is /root/evogent.`,
    `If you create feed items via /api/internal/curate/submit from this chat, include originSessionId "${input.sessionId}" on the submitted items or the request body. The chat UI uses originSessionId to link suggestions back to this chat thread for inline rendering. Suggestions submitted without it appear only in the main feed and the suggestions panel, never inline.`,
    'Before your first code_fix suggestion or direct product-source edit in this chat session, resolve .evogent-mode.md mode. Probe the current directory with the actual commands git -C "$PWD" rev-parse --is-inside-work-tree (git rev-parse --is-inside-work-tree) and, only when it reports true, git -C "$PWD" remote (git remote); non-empty git remote stdout means a remote is configured.',
    'Check .evogent-mode.md. If .evogent-mode.md does not exist but .claude/dev-agent-addon.md does AND is untracked, treat the legacy file as the source of truth for this turn AND, after parsing its mode, write the same mode to .evogent-mode.md and delete the legacy .claude/dev-agent-addon.md. This migrates existing repos automatically without re-prompting the user. If .evogent-mode.md exists, run git -C "$PWD" ls-files --error-unmatch .evogent-mode.md 2>/dev/null. If that exits 0, the addon is tracked by git; treat it as absent because it is repo pollution, not user consent. If it is present and untracked, parse top-level mode:. Valid modes are direct, suggestion-local, and suggestion-remote. If mode is valid, honor it and skip setup. If mode is missing but mergeAfterGates: true or mergeAfterGates: false is present, treat it as legacy mode: suggestion-remote and honor mergeAfterGates.',
    'If no valid untracked addon mode was resolved, ask the setup question for the probed state. Not in a git repo: "How should I work in this directory? Reply (direct) for me to edit files directly, or (init+suggestion) to git init and use the suggestion approval pipeline."',
    'Git repo with no remote: "How should I work in this repo? Reply (direct) for me to edit files directly, or (suggestion) to propose code_fix suggestions you approve — merges land locally on main, no push."',
    'Git repo with a remote: "How should I work in this repo? Reply (direct) for me to edit files directly, or (suggestion-merge) to propose code_fix and auto-merge to main + push to GitHub when tests pass, or (suggestion-review) to propose code_fix and pause before merging so you can review."',
    'After the user answers, write .evogent-mode.md for the resolved mode. direct writes exactly "---\\nmode: direct\\n---\\n"; init+suggestion first runs git init if needed and writes exactly "---\\nmode: suggestion-local\\n---\\n"; suggestion writes exactly "---\\nmode: suggestion-local\\n---\\n"; suggestion-merge writes exactly "---\\nmode: suggestion-remote\\nmergeAfterGates: true\\n---\\n"; suggestion-review writes exactly "---\\nmode: suggestion-remote\\nmergeAfterGates: false\\n---\\n". Omit mergeAfterGates for direct and suggestion-local.',
    'After writing .evogent-mode.md, if the addon file was tracked before the question, run git -C "$PWD" rm --cached .evogent-mode.md before the gitignore step. Then run git -C "$PWD" ls-files --error-unmatch .evogent-mode.md; if exit 0, skip the gitignore step. Otherwise run git -C "$PWD" check-ignore -q .evogent-mode.md; if exit 0, skip the gitignore step. Otherwise append a single .evogent-mode.md line to .gitignore, creating .gitignore if needed, ensuring a trailing newline and no duplicate line, then run git -C "$PWD" add .gitignore && git -C "$PWD" commit -m "chore: gitignore Evogent mode file"; do not commit the addon file itself and do not push. Then proceed according to the resolved mode.',
    'If resolved mode is suggestion-local or suggestion-remote, submit code_fix suggestions as today. In suggestion-local, approved fixes merge onto local main and do not push. In suggestion-remote, mergeAfterGates: true or false governs auto-merge and push exactly as before.',
    chatAddonBody,
    'Direct-mode override: If resolved mode is direct, you MAY edit files directly in this repo for this chat session and going forward; this explicitly overrides any loaded .claude/chat-addon.md instruction that says not to directly edit tracked product source, tracked docs, commands, skills, or code.',
  ].filter(Boolean).join('\n');
}

export function buildCuratorChatInstruction(input: {
  message: string;
  context: string | null;
  inReplyTo: string | null;
  messageId: string;
  sessionId: string;
  sessionTitle: string | null;
  attachmentPaths?: string[];
}): string {
  const curatorInstructionDocument = readInstructionDocument(
    '.claude/commands/curate-chat.md',
    'Curator chat sessions may directly edit data/config.md, data/curation-prompt.md, and data/preference-insights.md. For /curate, including /curate with a URL or focus, run the shared curation flow from .claude/commands/curate.md and prefer browse_cache_items before live browsing.',
  );
  const slashCommand = getSlashCommandName(input.message);
  const timeZoneConfig = readTimeZoneConfig(path.join(process.cwd(), 'data', 'config.md'));
  const latestInstructionDocument = slashCommand === 'curate-latest'
    ? readInstructionDocument(
        '.claude/commands/curate-latest.md',
        'Run .claude/commands/curate-latest.md directly. This is a direct-browse latest-content pass, not the cache-first /curate flow.',
      )
    : null;

  return [
    ...buildSharedChatEnvelope(input),
    `SessionTitle: ${input.sessionTitle?.trim() || 'Curator'}`,
    `ConfiguredTimeZone: ${timeZoneConfig.timeZone}`,
    'You are running inside a curator chat session.',
    'Follow the curator instruction document below directly for this turn.',
    'Curator chat sessions override the normal chat write-boundary: they MAY directly edit only data/config.md, data/curation-prompt.md, and data/preference-insights.md.',
    'For data/config.md, apply explicit concrete personal settings directly, such as Agent Name = Bob. Ask first when ambiguous, broad, or destructive. Never print or edit secrets.',
    'No other direct file writes are allowed from curator chat.',
    'When the user message is /curate or starts with /curate, execute the shared curation flow from .claude/commands/curate.md instead of inventing a parallel curation routine.',
    'When the user message is /curate-latest, execute .claude/commands/curate-latest.md directly; keep it direct-browse/latest-content and do not route it through the cache-first /curate behavior.',
    'When the user asks for fresh source material, you may enqueue a low-priority cache refresh with POST /api/internal/orchestrator/enqueue using priority "cache_refresh" and a message like "/cache-refresh twitter".',
    'When curation accepts items, auto-submit them through POST /api/internal/curate/submit and include originSessionId "' + input.sessionId + '" on the request body or each item.',
    'If you use browse-cache items during curation, follow the required mark-seen step from .claude/commands/curate.md before submit.',
    'Respond by POSTing exactly one JSON body to $MEDIA_AGENT_INTERNAL_BASE_URL/api/internal/chat/submit. Do not write chat-output.jsonl directly.',
    'Submit {"type":"chat","id":"chat-...","role":"agent","inReplyTo":"' + input.messageId + '","text":"...","taskId":"$MEDIA_AGENT_TASK_ID","timestamp":"ISO8601","sessionId":"' + input.sessionId + '"}.',
    '',
    '## Curator Instruction Document',
    curatorInstructionDocument,
    latestInstructionDocument ? '## Curate Latest Instruction Document' : null,
    latestInstructionDocument,
  ].filter(Boolean).join('\n');
}
