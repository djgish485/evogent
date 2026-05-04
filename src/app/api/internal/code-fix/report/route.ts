import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { buildChatInstruction } from '@/lib/chat-instruction';
import { getDb } from '@/lib/db/client';
import { getFeedItemById, updateFeedItemFields } from '@/lib/db/feed';
import { getChatSession } from '@/lib/db/chat-sessions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type ReportBody = Partial<Record<'taskId' | 'suggestionId' | 'phase' | 'status' | 'reason' | 'commitSha', unknown>>;

function trim(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isTerminalTaskStatus(status: string): boolean {
  return status === 'merged' || status === 'failed';
}

function getInternalBaseUrl(): string {
  const port = process.env.PORT || '3001';
  return process.env.MEDIA_AGENT_INTERNAL_BASE_URL || `http://127.0.0.1:${port}`;
}

async function broadcastEvent(payload: Record<string, unknown>) {
  try {
    await fetch(`${getInternalBaseUrl()}/api/internal/agent-progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: payload, trigger: 'code_fix_self_report' }),
    });
  } catch {
    // best effort, broadcast is non-critical
  }
}

function buildSuccessChatMessage(args: { taskId: string; suggestionId: string; title: string; commitSha: string }): string {
  const { taskId, suggestionId, title, commitSha } = args;
  const suggestionLine = title ? `Suggestion: ${suggestionId} (${title})` : `Suggestion: ${suggestionId}`;
  return [
    'A code-fix you authorized just merged.',
    `Task: ${taskId}`,
    suggestionLine,
    commitSha ? `Merge commit: ${commitSha}` : '',
    '',
    'Audit this merge:',
    '1. Re-read `data/config.md` and `CLAUDE.md` design philosophy. Did the merge follow it?',
    commitSha
      ? `2. Run \`git show ${commitSha} --stat\` and inspect the diff. Did it remove any functionality that should not have been removed, especially anything outside the suggestion scope?`
      : '2. Inspect the merge diff. Did it remove any functionality that should not have been removed, especially anything outside the suggestion scope?',
    '3. Did net line count move in the direction the suggestion specified? If it said lines should go down, did they?',
    '4. Are there any backward-compat hacks, feature flags, or removed-code comments left behind?',
    '5. Did it touch out-of-bounds files the suggestion forbade, such as `lib/providers/{claude,codex}-provider.js` or `src/lib/sub-agent.ts`?',
    '',
    'Reply with a brief audit report. If clean, say so in one sentence. If issues found, summarize them and submit a focused follow-up code_fix.',
  ].filter(Boolean).join('\n');
}

function buildFailureChatMessage(args: { taskId: string; suggestionId: string; title: string; phase: string; reason: string }): string {
  const { taskId, suggestionId, title, phase, reason } = args;
  const suggestionLabel = title ? ` (${title})` : '';
  return [
    `Code-fix task ${taskId} reached a terminal failed state for suggestion ${suggestionId}${suggestionLabel}.`,
    `Phase: ${phase || 'unknown'}.`,
    `Reason: ${reason || 'unspecified'}.`,
    '',
    'Diagnose this failure. Decide whether to update the original suggestion, dismiss it, retry, or submit a focused follow-up code_fix. Do not auto-accept or auto-merge.',
  ].join('\n');
}

async function postInternalJson(path: string, body: Record<string, unknown>, label: string) {
  try {
    const response = await fetch(`${getInternalBaseUrl()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify(body),
    });
    if (!response.ok) console.warn(`[code-fix-report] ${label} failed (${response.status}): ${await response.text().catch(() => '')}`);
  } catch (error) {
    console.warn(`[code-fix-report] ${label} failed`, error);
  }
}

async function postChatCallback(args: { sessionId: string; message: string; taskId: string; suggestionId: string; status: string; phase: string }) {
  if (!args.sessionId) return;
  const callbackMessageId = `chat-code-fix-${randomUUID()}`;
  const session = getChatSession(args.sessionId);
  const metadata = { callbackSource: 'code_fix_self_report', taskId: args.taskId, suggestionId: args.suggestionId, status: args.status, phase: args.phase, sessionId: args.sessionId };
  await postInternalJson('/api/internal/chat/submit', { type: 'chat', id: callbackMessageId, text: args.message, taskId: args.taskId, sessionId: args.sessionId, metadata }, 'persist chat callback');
  await postInternalJson('/api/internal/orchestrator/enqueue', {
    message: buildChatInstruction({ message: args.message, context: null, inReplyTo: callbackMessageId, messageId: callbackMessageId, sessionId: args.sessionId, cwd: session?.workingDirectory || process.cwd() }),
    priority: 'user_chat',
    source: 'code_fix_self_report',
    requestId: `chat-queue-${callbackMessageId}`,
    metadata: { ...metadata, endpoint: '/api/internal/code-fix/report', chatMessageId: callbackMessageId, inReplyTo: callbackMessageId, provider: session?.provider, providerSessionId: session?.providerSessionId, claudeReasoningEffort: session?.claudeReasoningEffort, codexReasoningEffort: session?.codexReasoningEffort, codexFastMode: session?.codexFastMode, workingDirectory: session?.workingDirectory, sessionType: session?.sessionType, forceFreshChatSession: false, attachments: [] },
  }, 'enqueue chat audit callback');
}

export async function POST(request: Request) {
  let payload: ReportBody;
  try {
    payload = (await request.json()) as ReportBody;
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const taskId = trim(payload.taskId);
  const phase = trim(payload.phase);
  const reportedStatus = trim(payload.status);
  const suggestionId = trim(payload.suggestionId);
  const reason = trim(payload.reason);
  const commitSha = trim(payload.commitSha);

  if (!taskId || !phase || !reportedStatus) {
    return NextResponse.json({ ok: false, error: 'taskId, phase, and status are required' }, { status: 400 });
  }

  const missingDoneCommitSha = reportedStatus === 'done' && !commitSha;
  const status = missingDoneCommitSha ? 'failed' : reportedStatus;
  const reportReason = missingDoneCommitSha
    ? 'no commit on main: status=done report did not include commitSha'
    : reason;
  if (missingDoneCommitSha) {
    console.warn(`[code-fix-report] task ${taskId} reported status=done without commitSha; treating report as failed`);
  }

  const db = getDb();
  const nowIso = new Date().toISOString();
  const isTerminal = status === 'done' || status === 'failed';

  const existingRow = db.prepare(
    `SELECT suggestion_id AS suggestionId, task_id AS taskId, status FROM code_fix_tasks WHERE task_id = ? LIMIT 1`,
  ).get(taskId) as { suggestionId: string; taskId: string; status: string } | undefined;

  const resolvedSuggestionId = suggestionId || existingRow?.suggestionId || '';

  const phaseDetail = reportReason
    ? `${phase}: ${reportReason}`
    : (status === 'progress' ? `${phase}` : `${phase} ${status}`);

  const taskStatus = isTerminal
    ? (status === 'done' ? 'merged' : 'failed')
    : 'running';
  const keepExistingTerminalTaskStatus = !isTerminal && isTerminalTaskStatus(existingRow?.status || '');
  const persistedTaskStatus = keepExistingTerminalTaskStatus ? existingRow?.status || taskStatus : taskStatus;
  let duplicateTerminalReport = isTerminal
    && isTerminalTaskStatus(existingRow?.status || '')
    && existingRow?.status === taskStatus;

  const error = status === 'failed' ? (reportReason || 'Agent reported failure without reason') : null;
  const completedAt = isTerminal ? nowIso : null;

  if (existingRow && (duplicateTerminalReport || keepExistingTerminalTaskStatus)) {
    db.prepare(
      `UPDATE code_fix_tasks
       SET status = ?, phase = ?, phase_detail = ?
       WHERE task_id = ?`,
    ).run(persistedTaskStatus, phase, phaseDetail.slice(0, 500), taskId);
  } else if (existingRow) {
    db.prepare(
      `UPDATE code_fix_tasks
       SET status = ?, phase = ?, phase_detail = ?, error = ?, completed_at = COALESCE(?, completed_at)
       WHERE task_id = ?`,
    ).run(taskStatus, phase, phaseDetail.slice(0, 500), error, completedAt, taskId);
  } else if (resolvedSuggestionId) {
    db.prepare(
      `INSERT OR REPLACE INTO code_fix_tasks (suggestion_id, task_id, status, phase, phase_detail, completed_at, error)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(resolvedSuggestionId, taskId, taskStatus, phase, phaseDetail.slice(0, 500), completedAt, error);
  }

  let originSessionId = '';
  let suggestionTitle = '';

  if (resolvedSuggestionId) {
    const feedItem = getFeedItemById(resolvedSuggestionId);
    if (feedItem) {
      suggestionTitle = typeof feedItem.title === 'string' ? feedItem.title : '';
      const itemMetadata = (feedItem.metadata as Record<string, unknown> | undefined) || {};
      const itemOriginSession = (feedItem as unknown as { originSessionId?: string }).originSessionId;
      originSessionId = trim(itemOriginSession) || trim(itemMetadata.originSessionId);
      const metadataTaskStatus = trim(itemMetadata.codeFixOrchestratorStatus);
      const metadataTaskId = trim(itemMetadata.taskId);
      if (
        !duplicateTerminalReport
        && isTerminal
        && metadataTaskId === taskId
        && isTerminalTaskStatus(metadataTaskStatus)
        && metadataTaskStatus === taskStatus
      ) {
        duplicateTerminalReport = true;
      }

      const hasTerminalMetadata = isTerminalTaskStatus(metadataTaskStatus)
        || Boolean(trim(itemMetadata.codeFixMergedAt))
        || Boolean(trim(itemMetadata.codeFixFailureReason));
      const keepExistingTerminalMetadataStatus = !isTerminal && hasTerminalMetadata;
      const metadataPatch: Record<string, unknown> = {
        codeFixPhase: phase,
        codeFixPhaseDetail: phaseDetail.slice(0, 500),
        codeFixLastReportAt: nowIso,
      };
      if (!keepExistingTerminalMetadataStatus) {
        metadataPatch.codeFixOrchestratorStatus = taskStatus;
      }

      if (isTerminal && !duplicateTerminalReport) {
        metadataPatch.suggestionStatus = status === 'done' ? 'merged' : 'failed';
        if (status === 'done') {
          metadataPatch.codeFixMergedAt = nowIso;
          if (commitSha) metadataPatch.codeFixMergedCommit = commitSha;
        }
        if (status === 'failed' && reportReason) {
          metadataPatch.codeFixFailureReason = reportReason;
        }
      } else if (!isTerminal && !hasTerminalMetadata) {
        metadataPatch.suggestionStatus = 'running';
      }

      updateFeedItemFields(resolvedSuggestionId, { metadata: metadataPatch });
    }
  }

  if (duplicateTerminalReport) {
    console.info(`[code-fix-report] ignored duplicate terminal report for task ${taskId} with status ${taskStatus}`);
  }

  if (isTerminal && originSessionId && !duplicateTerminalReport) {
    const message = status === 'done'
      ? buildSuccessChatMessage({
          taskId,
          suggestionId: resolvedSuggestionId,
          title: suggestionTitle,
          commitSha,
        })
      : buildFailureChatMessage({
          taskId,
          suggestionId: resolvedSuggestionId,
          title: suggestionTitle,
          phase,
          reason: reportReason,
        });
    await postChatCallback({
      sessionId: originSessionId,
      message,
      taskId,
      suggestionId: resolvedSuggestionId,
      status,
      phase,
    });
  }

  if (!duplicateTerminalReport) {
    await broadcastEvent({
      event: 'code_fix_self_report',
      taskId,
      suggestionId: resolvedSuggestionId,
      phase,
      status,
      reason: reportReason || undefined,
      commitSha: commitSha || undefined,
      timestamp: nowIso,
    });
  }

  return NextResponse.json({ ok: true, taskId, suggestionId: resolvedSuggestionId, status: persistedTaskStatus });
}
