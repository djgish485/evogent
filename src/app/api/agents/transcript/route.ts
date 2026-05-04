import fs from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { getDataPath } from '@/lib/data-dir';
import { extractTranscriptTextFromAgentLogEvent } from '@/lib/agent-log-events';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const AGENT_LOGS_DIR = path.resolve(getDataPath('agent-logs'));
const TASK_LOGS_DIR = path.resolve(getDataPath('task-logs'));
const SHARED_AGENT_LOGS_DIR = process.env.MEDIA_AGENT_ROOT
  ? path.resolve(process.env.MEDIA_AGENT_ROOT, 'data', 'agent-logs')
  : AGENT_LOGS_DIR;
const SHARED_TASK_LOGS_DIR = process.env.MEDIA_AGENT_ROOT
  ? path.resolve(process.env.MEDIA_AGENT_ROOT, 'data', 'task-logs')
  : TASK_LOGS_DIR;

const ALLOWED_LOG_DIRS = [...new Set([
  AGENT_LOGS_DIR,
  TASK_LOGS_DIR,
  SHARED_AGENT_LOGS_DIR,
  SHARED_TASK_LOGS_DIR,
])];

function resolveLogFilePath(rawFile: string): string | null {
  const trimmed = rawFile.trim();
  if (!trimmed) return null;

  const resolved = path.resolve(trimmed);
  const inAllowedDir = ALLOWED_LOG_DIRS.some((baseDir) => (
    resolved === baseDir || resolved.startsWith(`${baseDir}${path.sep}`)
  ));
  const isJsonl = path.extname(resolved).toLowerCase() === '.jsonl';

  if (!inAllowedDir || !isJsonl) return null;
  return resolved;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const fileParam = searchParams.get('file');

  if (!fileParam || !fileParam.trim()) {
    return NextResponse.json({ error: 'file query parameter is required' }, { status: 400 });
  }

  const resolvedPath = resolveLogFilePath(fileParam);
  if (!resolvedPath) {
    return NextResponse.json({ error: 'Invalid transcript file path' }, { status: 400 });
  }

  let content: string;
  try {
    content = await fs.promises.readFile(resolvedPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return NextResponse.json({ error: 'Transcript file not found' }, { status: 404 });
    }

    return NextResponse.json({ error: 'Failed to read transcript file' }, { status: 500 });
  }

  const assistantMessages: string[] = [];

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        continue;
      }

      const event = parsed as Record<string, unknown>;
      const transcriptLines = extractTranscriptTextFromAgentLogEvent(event);
      for (const text of transcriptLines) {
        if (text) {
          assistantMessages.push(text);
        }
      }
    } catch {
      // Ignore malformed lines in streaming logs.
    }
  }

  return NextResponse.json({
    file: resolvedPath,
    transcript: assistantMessages.join('\n\n'),
    assistantMessageCount: assistantMessages.length,
  });
}
