import fs from 'node:fs';
import { NextResponse } from 'next/server';
import {
  CONFIG_DOCUMENT_TARGETS,
  ensureConfigTargetIntegrity,
  normalizeConfigDocumentContent,
  persistConfigContent,
} from '@/lib/config-storage';
import {
  ConfigApplyTaskError,
  claimConfigApplyTask,
  completeConfigApplyTask,
  configContentHash,
  getConfigApplyTaskForExecution,
  reconcileConfigApplyTask,
} from '@/lib/config-apply-tasks.js';
import { getDb } from '@/lib/db/client';
import { applySuggestionProgrammatic } from '@/lib/suggestion-apply';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

let applyQueue: Promise<void> = Promise.resolve();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function executeTask(taskId: string) {
  const db = getDb();
  let claimed = false;

  try {
    const queuedTask = getConfigApplyTaskForExecution(db, taskId);
    if (queuedTask.status === 'applied') {
      return {
        alreadyApplied: true,
        ...(queuedTask.result ?? {}),
      };
    }

    const targetKey = queuedTask.target as keyof typeof CONFIG_DOCUMENT_TARGETS;
    const target = CONFIG_DOCUMENT_TARGETS[targetKey];
    const integrity = await ensureConfigTargetIntegrity(target);
    if (!integrity.ok) throw new Error(integrity.message);

    const current = await fs.promises.readFile(target.filePath, 'utf8');
    const applied = applySuggestionProgrammatic(current, {
      diff: queuedTask.diff,
      sectionName: queuedTask.sectionName,
      proposedValue: queuedTask.proposedValue,
    });
    const nextContent = normalizeConfigDocumentContent(applied.content);
    const preContentSha256 = configContentHash(current);
    const postContentSha256 = configContentHash(nextContent);
    const result = {
      changed: preContentSha256 !== postContentSha256,
      method: applied.method,
      target: target.relativePath,
    };
    const claim = claimConfigApplyTask(db, taskId, {
      preContentSha256,
      postContentSha256,
      result,
    });
    claimed = true;
    const task = claim.task;
    const persisted = await persistConfigContent({
      target,
      content: nextContent,
      source: 'suggestion',
      suggestionId: task.suggestionId,
      expectedCurrentContentHash: preContentSha256,
    });
    if (!persisted.ok) {
      throw new ConfigApplyTaskError(
        persisted.message,
        persisted.statusCode,
        persisted.statusCode === 409
          ? 'CONFIG_APPLY_CONFLICT'
          : 'CONFIG_APPLY_WRITE_FAILED',
      );
    }

    completeConfigApplyTask(db, task.taskId, result);
    return result;
  } catch (error) {
    if (claimed) {
      try {
        const recovery = reconcileConfigApplyTask(db, taskId, {
          dataDir: process.env.DATA_DIR,
        });
        if (recovery.action === 'completed') {
          return {
            alreadyApplied: true,
            recoveredCompletion: true,
            ...(recovery.task?.result ?? {}),
          };
        }
      } catch {
        // Leave an unreconciled journal running. Startup recovery can safely retry it; marking
        // it failed here could lie about bytes that already landed in the atomic rename.
      }
    }
    throw error;
  }
}

async function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const previous = applyQueue;
  let release!: () => void;
  applyQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
  }
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Request body must be JSON' }, { status: 400 });
  }
  const taskId = isRecord(body) && typeof body.taskId === 'string'
    ? body.taskId.trim()
    : '';
  if (!taskId) {
    return NextResponse.json({ ok: false, error: 'taskId is required' }, { status: 400 });
  }

  try {
    const result = await serialize(() => executeTask(taskId));
    return NextResponse.json({ ok: true, taskId, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Config apply failed';
    const status = error instanceof ConfigApplyTaskError
      ? error.statusCode
      : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
