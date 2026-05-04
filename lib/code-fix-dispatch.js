'use strict';

/* eslint-disable @typescript-eslint/no-require-imports */
const { spawn } = require('node:child_process');
const path = require('node:path');
const { spawnSelfOrchestratingDevAgent } = require('./agent-self-orchestrate');
const { applyGitCredentialEnv } = require('./git-credential-env');
const {
  isGitOpsLockTimeoutError,
} = require('./git-ops-lock');

function isDevAgentCapacityError(errorOrMessage) {
  const message = errorOrMessage instanceof Error ? errorOrMessage.message : errorOrMessage;
  return typeof message === 'string' && /max concurrent agents/i.test(message);
}

const TEST_SUGGESTION_PREFIXES = Object.freeze([
  'api-like-test-',
  'ws-code-fix-',
  'test-',
]);

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function shouldSkipCodeFixDispatch(suggestionId) {
  const normalizedSuggestionId = normalizeString(suggestionId);
  return TEST_SUGGESTION_PREFIXES.some((prefix) => normalizedSuggestionId.startsWith(prefix));
}

function dispatchCodeFixSuggestionsInBackground(suggestions, options = {}) {
  const repoDir = normalizeString(options.repoDir) || process.cwd();
  const internalBaseUrl = normalizeString(options.internalBaseUrl)
    || process.env.MEDIA_AGENT_INTERNAL_BASE_URL
    || process.env.ORCHESTRATOR_INTERNAL_URL
    || `http://127.0.0.1:${process.env.PORT || '3001'}`;
  const workerPath = path.join(__dirname, 'code-fix-dispatch-worker.js');
  const env = applyGitCredentialEnv(process.env, {
    MEDIA_AGENT_INTERNAL_BASE_URL: internalBaseUrl,
  });

  delete env.MEDIA_AGENT_SPAWN_DEPTH;

  const child = spawn(process.execPath, [
    workerPath,
    JSON.stringify({
      repoDir,
      suggestions: Array.isArray(suggestions) ? suggestions : [],
    }),
  ], {
    cwd: repoDir,
    detached: true,
    env,
    stdio: 'ignore',
  });

  child.unref();
}

async function dispatchCodeFixSuggestionsDirect(suggestions, options = {}) {
  const repoDir = normalizeString(options.repoDir) || process.cwd();
  const spawnFn = typeof options.spawnSelfOrchestratingDevAgent === 'function'
    ? options.spawnSelfOrchestratingDevAgent
    : spawnSelfOrchestratingDevAgent;
  const results = [];

  for (const suggestion of Array.isArray(suggestions) ? suggestions : []) {
    const suggestionId = normalizeString(suggestion?.id);
    const descriptorSuggestionId = normalizeString(suggestion?.suggestionId) || suggestionId;
    const feedItemId = normalizeString(suggestion?.feedItemId) || descriptorSuggestionId || suggestionId;
    const originSessionId = normalizeString(suggestion?.originSessionId);
    const taskId = normalizeString(suggestion?.taskId);
    const prompt = normalizeString(suggestion?.proposedValue);

    if (!suggestionId || !taskId || !prompt) {
      results.push({
        ok: false,
        skipped: false,
        suggestionId,
        taskId,
        error: 'Suggestion id, taskId, and proposedValue are required for direct dispatch.',
      });
      continue;
    }

    if (shouldSkipCodeFixDispatch(suggestionId)) {
      results.push({
        ok: true,
        skipped: true,
        suggestionId,
        taskId,
      });
      continue;
    }

    try {
      const spawned = spawnFn({
        taskId,
        suggestion: {
          id: suggestionId,
          suggestionId: descriptorSuggestionId,
          feedItemId,
          originSessionId,
          title: normalizeString(suggestion?.title),
          text: normalizeString(suggestion?.text),
          proposedValue: prompt,
        },
        options: {
          repoDir,
          internalBaseUrl: normalizeString(options.internalBaseUrl) || undefined,
        },
      });
      results.push({
        ok: true,
        skipped: false,
        suggestionId,
        taskId,
        worktree: spawned.worktree,
        provider: spawned.provider,
        launchMode: spawned.launch?.mode,
      });
    } catch (error) {
      const noSlotAvailable = isDevAgentCapacityError(error);
      const retryable = noSlotAvailable || isGitOpsLockTimeoutError(error);
      const fallbackMessage = retryable
        ? noSlotAvailable
          ? 'No dev-agent slot is currently available. Retry dispatch after a slot frees.'
          : 'Timed out waiting for shared git operations. Retry dispatch.'
        : 'Failed to dispatch code fix directly to the dev-task pipeline.';
      results.push({
        ok: false,
        skipped: false,
        retryable,
        noSlotAvailable,
        suggestionId,
        taskId,
        error: error instanceof Error && error.message.trim()
          ? error.message.trim()
          : fallbackMessage,
      });
    }
  }

  return results;
}

module.exports = {
  dispatchCodeFixSuggestionsInBackground,
  dispatchCodeFixSuggestionsDirect,
  shouldSkipCodeFixDispatch,
  TEST_SUGGESTION_PREFIXES,
};
