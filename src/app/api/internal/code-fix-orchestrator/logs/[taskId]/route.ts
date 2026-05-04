import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const execFileAsync = promisify(execFile);
const DEFAULT_LINES = 30;
const MIN_LINES = 5;
const MAX_LINES = 500;
const TASK_ID_PATTERN = /^[A-Za-z0-9.-]+$/;

function parseLineCount(request: Request): number {
  const raw = new URL(request.url).searchParams.get('lines');
  const parsed = Number.parseInt(raw || '', 10);
  if (!Number.isFinite(parsed)) return DEFAULT_LINES;
  return Math.min(MAX_LINES, Math.max(MIN_LINES, parsed));
}

function parseJournalLines(stdout: string): string[] {
  if (!stdout) return [];

  const lines = stdout.replace(/\r\n/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }

  return lines;
}

function isJournalEmptyError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as { code?: unknown; stderr?: unknown };
  const stderr = typeof err.stderr === 'string' ? err.stderr : '';

  return err.code === 'ENOENT'
    || /no journal files were found/i.test(stderr)
    || /-- No entries --/i.test(stderr);
}

export async function GET(
  request: Request,
  context: { params: Promise<{ taskId: string }> },
) {
  const { taskId: rawTaskId } = await context.params;
  const taskId = typeof rawTaskId === 'string' ? rawTaskId.trim() : '';
  const lines = parseLineCount(request);

  if (!taskId || !TASK_ID_PATTERN.test(taskId)) {
    return NextResponse.json({ ok: true, lines: [] });
  }

  const unit = `evogent-dev-agent-${taskId}.service`;

  try {
    const result = await execFileAsync('journalctl', [
      '--unit',
      unit,
      '-n',
      String(lines),
      '--no-pager',
      '--output=cat',
    ], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      timeout: 10_000,
    });

    return NextResponse.json({ ok: true, lines: parseJournalLines(result.stdout) });
  } catch (error) {
    const stdout = typeof (error as { stdout?: unknown })?.stdout === 'string'
      ? (error as { stdout: string }).stdout
      : '';
    if (stdout) {
      return NextResponse.json({ ok: true, lines: parseJournalLines(stdout) });
    }

    if (isJournalEmptyError(error)) {
      return NextResponse.json({ ok: true, lines: [] });
    }

    const message = error instanceof Error ? error.message : 'Failed to read agent logs';
    return NextResponse.json({ ok: false, error: message, lines: [] }, { status: 500 });
  }
}
