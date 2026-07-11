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

function buildRequiredChatSubmitInstruction(input: { messageId: string; sessionId: string }): string {
  return [
    '=== REQUIRED FINAL CHAT SUBMIT ===',
    'Your turn MUST end by POSTing exactly one JSON body to $MEDIA_AGENT_INTERNAL_BASE_URL/api/internal/chat/submit. Do not write chat-output.jsonl directly. The "text" field must contain your full reply with real line breaks between paragraphs and after markdown headers. If you exit without POSTing, the orchestrator captures your raw output as a fallback, but the user sees one unbroken blob instead of properly formatted text. Example JSON body: {"type":"chat","id":"chat-...","role":"agent","inReplyTo":"' + input.messageId + '","text":"## Summary\\n\\nFirst paragraph.\\n\\n## Details\\n\\n- First item\\n- Second item","taskId":"$MEDIA_AGENT_TASK_ID","timestamp":"ISO8601","sessionId":"' + input.sessionId + '"}.',
    'If this turn answered a request for CONTENT or an ACTION (see the anticipation guidance in your instructions), add an "anticipation" field to that SAME JSON body — do NOT make a separate call — e.g. "anticipation":{"tier":"feed_hit","topics":["reinforcement learning"],"sourceHint":"youtube","waitedMs":1500}. Tier is feed_hit (answered from the feed), cache_hit (from the browse cache), or miss (had to live-browse/search or could not find it). Omit the field only for pure chit-chat, phone-control with no content, or meta questions about Evogent.',
    '=== END REQUIRED FINAL CHAT SUBMIT ===',
  ].join('\n');
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
    `ChatMessageId: ${input.messageId}`,
    `SessionId: ${input.sessionId}`,
    `${replyTargetText}${contextText}`.trim(),
    postContextBlock,
  ].filter((line): line is string => Boolean(line));
}

export interface ChatInstruction {
  prompt: string;
  appendSystemPrompt: string;
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
}): ChatInstruction {
  const cwd = input.cwd ?? process.cwd();
  const splitMessage = splitPostContext(input.message);
  const chatAddon = readPromptAddon(cwd, '.claude/chat-addon.md');
  const chatAddonBody = renderPromptAddonBody(chatAddon.body, { sessionId: input.sessionId });

  return {
    prompt: splitMessage.message,
    appendSystemPrompt: [
      ...buildSharedChatEnvelope(input),
      ...buildSlashCommandInstructionBlock(input),
      `Your working directory is ${cwd}.`,
      `If you create feed items via /api/internal/curate/submit from this chat, include originSessionId "${input.sessionId}" on the submitted items or the request body. The chat UI uses originSessionId to link suggestions back to this chat thread for inline rendering. Suggestions submitted without it appear only in the main feed and the suggestions panel, never inline.`,
      chatAddonBody,
      buildRequiredChatSubmitInstruction(input),
    ].filter(Boolean).join('\n'),
  };
}

export function buildCuratorChatInstruction(input: {
  message: string;
  context: string | null;
  inReplyTo: string | null;
  messageId: string;
  sessionId: string;
  sessionTitle: string | null;
  attachmentPaths?: string[];
}): ChatInstruction {
  const splitMessage = splitPostContext(input.message);
  const timeZoneConfig = readTimeZoneConfig(path.join(process.cwd(), 'data', 'config.md'));

  return {
    prompt: splitMessage.message,
    appendSystemPrompt: [
      ...buildSharedChatEnvelope(input),
      `SessionTitle: ${input.sessionTitle?.trim() || 'Curator'}`,
      `ConfiguredTimeZone: ${timeZoneConfig.timeZone}`,
      'You are running inside a curator chat session.',
      'Follow the curator instruction document below directly for this turn.',
      'Curator chat sessions override the normal chat write-boundary: they MAY directly edit only data/config.md, data/curation-prompt.md, and data/preference-insights.md.',
      'For data/config.md, apply explicit concrete personal settings directly, such as Agent Name = Bob. Ask first when ambiguous, broad, or destructive. Never print or edit secrets.',
      'No other direct file writes are allowed from curator chat.',
      'When the user asks for fresh source material, you may enqueue a low-priority cache refresh with POST /api/internal/orchestrator/enqueue using priority "cache_refresh" and a message like "/cache-refresh twitter".',
      buildRequiredChatSubmitInstruction(input),
    ].filter(Boolean).join('\n'),
  };
}
