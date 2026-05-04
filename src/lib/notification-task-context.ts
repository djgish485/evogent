import fs from 'node:fs/promises';
import path from 'node:path';

import { extractTranscriptTextFromAgentLogEvent } from '@/lib/agent-log-events';
import { getDataPath } from '@/lib/data-dir';
import type { FeedItem, NotificationTaskContext } from '@/types/feed';

const MAX_SUMMARY_LENGTH = 220;
const MAX_DETAIL_LINES = 3;
const MAX_DETAIL_LINE_LENGTH = 220;

interface TaskHistoryEntry {
  state?: string;
  response?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  error?: string | null;
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function normalizeText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return null;
  }

  return truncateText(normalized, maxLength);
}

function looksLikeStructuredPayload(value: string): boolean {
  return (value.startsWith('{') && value.endsWith('}'))
    || (value.startsWith('[') && value.endsWith(']'));
}

function dedupeLines(lines: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const line of lines) {
    const key = line.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(line);
  }

  return deduped;
}

function extractTextLines(value: unknown, maxLines = MAX_DETAIL_LINES): string[] {
  if (typeof value !== 'string') {
    return [];
  }

  const lines = value
    .split(/\n+/)
    .map((line) => normalizeText(line, MAX_DETAIL_LINE_LENGTH))
    .filter((line): line is string => Boolean(line))
    .filter((line) => !looksLikeStructuredPayload(line));

  return dedupeLines(lines).slice(-maxLines);
}

function getTaskLogCandidates(taskId: string): string[] {
  const candidates = [
    path.resolve(getDataPath('task-logs', `${taskId}.jsonl`)),
  ];

  if (process.env.MEDIA_AGENT_ROOT) {
    candidates.push(path.resolve(process.env.MEDIA_AGENT_ROOT, 'data', 'task-logs', `${taskId}.jsonl`));
  }

  return [...new Set(candidates)];
}

async function readFirstExistingFile(paths: string[]): Promise<string | null> {
  for (const filePath of paths) {
    try {
      return await fs.readFile(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  return null;
}

async function loadTaskTranscriptLines(taskId: string): Promise<string[]> {
  const content = await readFirstExistingFile(getTaskLogCandidates(taskId));
  if (!content) {
    return [];
  }

  const transcriptLines: string[] = [];

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        continue;
      }

      for (const transcriptText of extractTranscriptTextFromAgentLogEvent(parsed as Record<string, unknown>)) {
        transcriptLines.push(...extractTextLines(transcriptText, MAX_DETAIL_LINES));
      }
    } catch {
      // Ignore malformed streaming log lines.
    }
  }

  return dedupeLines(transcriptLines).slice(-MAX_DETAIL_LINES);
}

function getInternalBaseUrl(): string {
  if (process.env.ORCHESTRATOR_INTERNAL_URL) {
    return process.env.ORCHESTRATOR_INTERNAL_URL;
  }

  return `http://127.0.0.1:${process.env.PORT || '3001'}`;
}

async function loadTaskHistoryEntry(taskId: string): Promise<TaskHistoryEntry | null> {
  try {
    const response = await fetch(`${getInternalBaseUrl()}/api/orchestrator/history/${encodeURIComponent(taskId)}`, {
      cache: 'no-store',
    });
    if (!response.ok) {
      return null;
    }

    return await response.json() as TaskHistoryEntry;
  } catch {
    return null;
  }
}

function normalizeTaskState(value: unknown): NotificationTaskContext['state'] {
  switch (value) {
    case 'queued':
    case 'processing':
    case 'completed':
    case 'failed':
      return value;
    default:
      return null;
  }
}

function shouldSkipLine(line: string, item: FeedItem, summary: string | null): boolean {
  const normalizedLine = line.trim().toLowerCase();
  if (!normalizedLine) {
    return true;
  }

  const duplicates = [
    item.text,
    item.excerpt,
    item.metadata?.taskSummary,
    summary,
  ]
    .map((value) => normalizeText(value, MAX_DETAIL_LINE_LENGTH))
    .filter((value): value is string => Boolean(value))
    .map((value) => value.toLowerCase());

  return duplicates.includes(normalizedLine);
}

async function buildNotificationTaskContext(item: FeedItem): Promise<NotificationTaskContext | null> {
  const taskId = typeof item.metadata?.taskId === 'string' ? item.metadata.taskId.trim() : '';
  if (!taskId) {
    return null;
  }

  const [transcriptLines, history] = await Promise.all([
    loadTaskTranscriptLines(taskId),
    loadTaskHistoryEntry(taskId),
  ]);

  const summary = normalizeText(
    item.metadata?.taskSummary
      ?? history?.error
      ?? (
        transcriptLines.length === 0
        && typeof history?.response === 'string'
        && !looksLikeStructuredPayload(history.response.trim())
          ? history.response
          : null
      ),
    MAX_SUMMARY_LENGTH,
  );

  const detailLines = dedupeLines([
    ...transcriptLines,
    ...extractTextLines(history?.response ?? null),
  ]).filter((line) => !shouldSkipLine(line, item, summary));

  if (!summary && detailLines.length === 0) {
    return null;
  }

  return {
    taskId,
    state: normalizeTaskState(history?.state),
    updatedAt: history?.completedAt ?? history?.startedAt ?? null,
    summary,
    lines: detailLines.slice(-MAX_DETAIL_LINES),
  };
}

export async function enrichFeedItemsWithNotificationTaskContext(items: FeedItem[]): Promise<FeedItem[]> {
  const taskContextByTaskId = new Map<string, Promise<NotificationTaskContext | null>>();

  return Promise.all(items.map(async (item) => {
    if (item.type !== 'notification') {
      return item;
    }

    const taskId = typeof item.metadata?.taskId === 'string' ? item.metadata.taskId.trim() : '';
    if (!taskId) {
      return item;
    }

    let pendingContext = taskContextByTaskId.get(taskId);
    if (!pendingContext) {
      pendingContext = buildNotificationTaskContext(item);
      taskContextByTaskId.set(taskId, pendingContext);
    }

    return {
      ...item,
      notificationTaskContext: await pendingContext,
    };
  }));
}
