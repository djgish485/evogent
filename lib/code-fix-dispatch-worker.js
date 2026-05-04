'use strict';

/* eslint-disable @typescript-eslint/no-require-imports */
const { dispatchCodeFixSuggestionsDirect } = require('./code-fix-dispatch');

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function getInternalBaseUrl() {
  return process.env.MEDIA_AGENT_INTERNAL_BASE_URL
    || process.env.ORCHESTRATOR_INTERNAL_URL
    || `http://127.0.0.1:${process.env.PORT || '3001'}`;
}

async function postReport(payload) {
  await fetch(`${getInternalBaseUrl()}/api/internal/code-fix/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify(payload),
  });
}

async function settleDispatchResults(results) {
  for (const result of Array.isArray(results) ? results : []) {
    const suggestionId = normalizeString(result?.suggestionId);
    const taskId = normalizeString(result?.taskId);
    if (!suggestionId || !taskId || result?.skipped) {
      continue;
    }

    if (result?.ok) {
      await postReport({
        taskId,
        suggestionId,
        phase: 'agent_dispatch',
        status: 'progress',
        reason: 'Dispatched directly to dev-task pipeline',
      });
      continue;
    }

    if (result?.noSlotAvailable || result?.retryable) {
      await postReport({
        taskId,
        suggestionId,
        phase: 'agent_dispatch',
        status: 'progress',
        reason: normalizeString(result?.error) || 'Waiting to retry direct dev-task dispatch.',
      });
      continue;
    }

    await postReport({
      taskId,
      suggestionId,
      phase: 'agent_dispatch',
      status: 'failed',
      reason: normalizeString(result?.error) || 'Direct dev-task dispatch failed.',
    });
  }
}

async function main() {
  const rawPayload = process.argv[2] || '{}';
  const payload = JSON.parse(rawPayload);
  const suggestions = Array.isArray(payload?.suggestions) ? payload.suggestions : [];
  const repoDir = normalizeString(payload?.repoDir) || process.cwd();

  try {
    await settleDispatchResults(await dispatchCodeFixSuggestionsDirect(suggestions, { repoDir }));
  } catch (error) {
    const message = error instanceof Error && error.message.trim()
      ? error.message.trim()
      : 'Direct dev-task dispatch failed.';
    await settleDispatchResults(suggestions.map((suggestion) => ({
      ok: false,
      skipped: false,
      suggestionId: normalizeString(suggestion?.id),
      taskId: normalizeString(suggestion?.taskId),
      error: message,
    })));
    throw error;
  }
}

if (require.main === module) {
  main().catch((error) => {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  settleDispatchResults,
};
