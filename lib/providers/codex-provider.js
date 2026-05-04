const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeCodexReasoningEffort } = require('../brain-config');

const CODEX_BYPASS_APPROVALS_AND_SANDBOX_ARG = '--dangerously-bypass-approvals-and-sandbox';

const USER_CHAT_CONCISENESS_OVERLAY = [
  'Lead with the answer or action, not the reasoning. If the answer fits in one sentence, use one sentence.',
  'State what the data says with high confidence. Do not hedge with maybe/perhaps/it depends unless genuinely uncertain about a specific fact.',
  'Never open with filler like Great question or I would be happy to help. Just answer.',
  'Skip preamble and context-setting. The user has context — they asked the question.',
  'Prefer concise, information-dense writing. Keep progress updates to 1-2 sentences.',
].join('\n');

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function truncate(value, maxLength = 120) {
  if (typeof value !== 'string') {
    return '';
  }

  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 1))}...`;
}

function extractTextValue(value) {
  if (typeof value === 'string') {
    return value.trim();
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => extractTextValue(entry))
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  if (!isRecord(value)) {
    return '';
  }

  if (typeof value.text === 'string' && value.text.trim()) {
    return value.text.trim();
  }

  if (typeof value.message === 'string' && value.message.trim()) {
    return value.message.trim();
  }

  if (value.content !== undefined) {
    const nested = extractTextValue(value.content);
    if (nested) {
      return nested;
    }
  }

  return '';
}

function extractCodexItem(rawEvent) {
  if (!isRecord(rawEvent)) {
    return null;
  }

  return isRecord(rawEvent.item) ? rawEvent.item : null;
}

function summarizeCommandExecution(item) {
  if (!isRecord(item)) {
    return '';
  }

  if (Array.isArray(item.parsed_cmd) && item.parsed_cmd.length > 0) {
    return truncate(item.parsed_cmd.join(' '), 80);
  }

  if (typeof item.command === 'string' && item.command.trim()) {
    return truncate(item.command, 80);
  }

  if (typeof item.description === 'string' && item.description.trim()) {
    return truncate(item.description, 80);
  }

  return '';
}

function summarizeWebSearch(item) {
  if (!isRecord(item)) {
    return '';
  }

  if (typeof item.query === 'string' && item.query.trim()) {
    return truncate(item.query, 80);
  }

  const action = isRecord(item.action) ? item.action : null;
  if (typeof action?.url === 'string' && action.url.trim()) {
    return truncate(action.url, 80);
  }

  return '';
}

function resolveProgressFromItem(item) {
  if (!isRecord(item) || typeof item.type !== 'string') {
    return null;
  }

  const type = item.type.trim();
  switch (type) {
    case 'web_search': {
      const detail = summarizeWebSearch(item);
      return {
        activity: detail ? `Searching the web for ${detail}...` : 'Searching the web...',
        tool: 'web_search',
      };
    }
    case 'command_execution': {
      const detail = summarizeCommandExecution(item);
      return {
        activity: detail ? `Running ${detail}...` : 'Running a command...',
        tool: 'command_execution',
      };
    }
    case 'agent_reasoning':
    case 'reasoning':
      return {
        activity: 'Thinking...',
        tool: 'Thinking',
      };
    default:
      return null;
  }
}

function summarizeCodexEvent(rawEvent) {
  if (!isRecord(rawEvent) || typeof rawEvent.type !== 'string') {
    return null;
  }

  if (rawEvent.type === 'thread.started') {
    return 'thread.started';
  }

  if (rawEvent.type === 'turn.started' || rawEvent.type === 'turn.completed') {
    return rawEvent.type;
  }

  const item = extractCodexItem(rawEvent);
  if (!item || typeof item.type !== 'string') {
    return rawEvent.type;
  }

  return `${rawEvent.type} ${item.type}`;
}

function formatCodexTranscriptLines(rawEvent) {
  if (!isRecord(rawEvent) || typeof rawEvent.type !== 'string') {
    return [];
  }

  if (rawEvent.type === 'context_compacted') {
    const compactMetrics = extractCodexAutoCompaction(rawEvent);
    if (compactMetrics?.postTokens) {
      return [`[context] compacted automatically to ${compactMetrics.postTokens} tokens`];
    }
    return ['[context] compacted automatically'];
  }

  const item = extractCodexItem(rawEvent);
  if (rawEvent.type === 'item.started' && isRecord(item)) {
    if (item.type === 'web_search') {
      const detail = summarizeWebSearch(item);
      return [detail ? `[web] ${detail}` : '[web] search started'];
    }

    if (item.type === 'command_execution') {
      const detail = summarizeCommandExecution(item);
      return [detail ? `[bash] ${detail}` : '[bash] command started'];
    }
  }

  if (rawEvent.type === 'item.completed' && isRecord(item)) {
    if (item.type === 'agent_message') {
      const text = extractTextValue(item.text ?? item.message ?? item.content);
      return text ? [truncate(text, 620)] : [];
    }

    if (item.type === 'command_execution') {
      const output = extractTextValue(item.output);
      return output ? [truncate(output, 620)] : [];
    }
  }

  if (rawEvent.type === 'error') {
    const message = extractTextValue(rawEvent.error ?? rawEvent.message);
    return message ? [`[error] ${truncate(message, 620)}`] : [];
  }

  return [];
}

function extractCodexAgentMessageText(rawEvent) {
  if (!isRecord(rawEvent)) {
    return '';
  }

  const item = extractCodexItem(rawEvent);
  if (!isRecord(item) || item.type !== 'agent_message') {
    return '';
  }

  return extractTextValue(item.text ?? item.message ?? item.content);
}

function normalizePositiveInteger(value) {
  if (typeof value === 'string' && !value.trim()) {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0
    ? Math.floor(numeric)
    : null;
}

function readCodexModelsCachePath(deps = {}) {
  if (typeof deps.codexModelsCachePath === 'string' && deps.codexModelsCachePath.trim()) {
    return deps.codexModelsCachePath.trim();
  }
  return path.join(os.homedir(), '.codex', 'models_cache.json');
}

function modelCacheEntryMatches(entry, modelId) {
  if (!isRecord(entry) || typeof modelId !== 'string' || !modelId.trim()) {
    return false;
  }

  const target = modelId.trim();
  const candidates = [
    entry.slug,
    entry.id,
    entry.name,
    entry.model,
    entry.model_id,
  ];

  return candidates.some((candidate) => typeof candidate === 'string' && candidate.trim() === target);
}

function listCodexModelCacheEntries(parsed) {
  if (Array.isArray(parsed?.models)) {
    return parsed.models;
  }

  if (isRecord(parsed?.models)) {
    return Object.entries(parsed.models).map(([slug, value]) => (
      isRecord(value) && typeof value.slug !== 'string'
        ? { ...value, slug }
        : value
    ));
  }

  if (Array.isArray(parsed)) {
    return parsed;
  }

  return [];
}

function readCodexModelDefaultContextWindow(modelId, deps = {}) {
  try {
    const readFileSync = typeof deps.readFileSync === 'function' ? deps.readFileSync : fs.readFileSync;
    const raw = readFileSync(readCodexModelsCachePath(deps), 'utf8');
    const parsed = JSON.parse(raw);
    const target = listCodexModelCacheEntries(parsed).find((entry) => modelCacheEntryMatches(entry, modelId));
    if (!isRecord(target)) {
      return null;
    }

    const explicitWindow = normalizePositiveInteger(target.context_window);
    const effectivePercent = normalizePositiveInteger(target.effective_context_window_percent);
    if (explicitWindow === null) {
      return null;
    }
    if (effectivePercent === null) {
      return explicitWindow;
    }
    return Math.max(1, Math.floor(explicitWindow * (effectivePercent / 100)));
  } catch {
    return null;
  }
}

function resolveCodexContextWindow(modelId, deps = {}) {
  return readCodexModelDefaultContextWindow(modelId, deps);
}

function extractNestedRecord(rawEvent, keys) {
  for (const key of keys) {
    const candidate = rawEvent?.[key];
    if (isRecord(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolveCodexMetricModelId(rawEvent, fallbackModelId) {
  const candidates = [
    rawEvent?.model,
    rawEvent?.model_id,
    rawEvent?.modelId,
    rawEvent?.model_slug,
    fallbackModelId,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

function extractCodexTokenCountContext(rawEvent, fallbackContextWindow, fallbackModelId) {
  if (!isRecord(rawEvent) || rawEvent.type !== 'token_count') {
    return null;
  }

  const info = isRecord(rawEvent.info) ? rawEvent.info : null;
  const usage = extractNestedRecord(rawEvent, ['last_token_usage', 'token_usage', 'usage'])
    || extractNestedRecord(info, ['last_token_usage', 'token_usage', 'usage']);
  const contextTokens = normalizePositiveInteger(
    usage?.input_tokens
    ?? usage?.inputTokens
    ?? rawEvent.input_tokens
    ?? rawEvent.inputTokens,
  );
  const reportedContextWindow = normalizePositiveInteger(
    rawEvent.model_context_window
    ?? rawEvent.context_window
    ?? info?.model_context_window
    ?? info?.context_window
    ?? usage?.model_context_window
    ?? usage?.context_window,
  );

  if (contextTokens === null && reportedContextWindow === null) {
    return null;
  }

  return {
    modelId: resolveCodexMetricModelId(rawEvent, fallbackModelId),
    contextTokens,
    contextWindow: reportedContextWindow ?? fallbackContextWindow,
    replaceContextTokens: true,
  };
}

function extractCodexAutoCompaction(rawEvent) {
  if (!isRecord(rawEvent) || rawEvent.type !== 'context_compacted') {
    return null;
  }

  const usage = extractNestedRecord(rawEvent, ['last_token_usage', 'token_usage', 'usage']);
  const preTokens = normalizePositiveInteger(
    rawEvent.pre_tokens
    ?? rawEvent.preTokens
    ?? rawEvent.tokens_before
    ?? rawEvent.tokensBefore
    ?? rawEvent.context_tokens_before
    ?? rawEvent.contextTokensBefore,
  );
  const postTokens = normalizePositiveInteger(
    rawEvent.post_tokens
    ?? rawEvent.postTokens
    ?? rawEvent.tokens_after
    ?? rawEvent.tokensAfter
    ?? rawEvent.context_tokens_after
    ?? rawEvent.contextTokensAfter
    ?? usage?.input_tokens
    ?? usage?.inputTokens,
  );

  if (preTokens === null && postTokens === null) {
    return { preTokens: null, postTokens: null, automatic: true };
  }

  return {
    preTokens,
    postTokens,
    automatic: true,
  };
}

function createCodexProvider(deps = {}, brainConfig) {
  const resolvedContextWindow = resolveCodexContextWindow(brainConfig.codexModel, deps);

  return {
    name: 'codex',
    displayName: 'Codex CLI',
    binaryName: 'codex',
    config: brainConfig,
    buildAvailabilityCheck() {
      return {
        command: 'codex',
        args: ['--version'],
      };
    },
    supportsManualCompaction() {
      return false;
    },
    buildInvocation({ prompt, systemPrompt, sessionMode, task }) {
      const fullPrompt = [
        'Follow the system instructions below for this invocation.',
        '',
        task?.priority === 'user_chat' ? USER_CHAT_CONCISENESS_OVERLAY : null,
        task?.priority === 'user_chat' ? '' : null,
        systemPrompt,
        '',
        prompt,
      ].filter((value) => value !== null).join('\n');

      const args = sessionMode?.mode === 'resume'
        ? ['exec', 'resume']
        : ['exec'];
      const isCacheRefreshTask = task?.priority === 'cache_refresh';
      const isPostEnrichmentTask = task?.priority === 'post_enrichment';
      const downshiftedEffortTasks = isCacheRefreshTask || isPostEnrichmentTask;
      const requestedReasoning = isRecord(task?.metadata) ? task.metadata.codexReasoningEffort : null;
      // Codex calibration on 2026-04-29 kept gpt-5.5 prompts/tools/permission
      // mode fixed and changed only model_reasoning_effort.
      // Browse cache-refresh path (/cache-refresh twitter): medium persisted 53
      // items in 472s for about $0.26 vs high 33 items in 433s for about $0.71.
      // Post-enrichment buildEnrichmentPrompt idle path: medium finished in 130s
      // for about $0.16 vs high 148s for about $0.30.
      // Explicit metadata.codexReasoningEffort remains highest priority.
      const sessionReasoning = normalizeCodexReasoningEffort(
        typeof requestedReasoning === 'string' && requestedReasoning.trim()
          ? requestedReasoning
          : downshiftedEffortTasks
            ? 'medium'
            : brainConfig.codexReasoningEffort,
      );

      args.push('--json');
      args.push('--model', brainConfig.codexModel);
      args.push('-c', `model_reasoning_effort=${sessionReasoning}`);
      if (task?.metadata?.codexFastMode === true) {
        args.push('-c', 'service_tier="fast"');
      }
      args.push(CODEX_BYPASS_APPROVALS_AND_SANDBOX_ARG);

      if (sessionMode?.mode === 'resume') {
        args.push(sessionMode.sessionId, fullPrompt);
      } else {
        args.push(fullPrompt);
      }

      return {
        command: 'codex',
        args,
        env: {},
      };
    },
    extractSessionId(rawEvent) {
      if (!isRecord(rawEvent)) {
        return null;
      }

      if (rawEvent.type === 'thread.started' && typeof rawEvent.thread_id === 'string') {
        return rawEvent.thread_id.trim() || null;
      }

      return null;
    },
    isFreshAssistantStreamingSignal() {
      return false;
    },
    collectAssistantText(rawEvent) {
      const text = extractCodexAgentMessageText(rawEvent);
      return text ? [text] : [];
    },
    extractStreamingChatText(rawEvent) {
      const text = extractCodexAgentMessageText(rawEvent);
      return text || null;
    },
    summarizeEvent(rawEvent) {
      return summarizeCodexEvent(rawEvent);
    },
    extractChatProgress(rawEvent) {
      if (!isRecord(rawEvent)) {
        return null;
      }

      if (rawEvent.type !== 'item.started' && rawEvent.type !== 'item.completed') {
        return null;
      }

      return resolveProgressFromItem(extractCodexItem(rawEvent));
    },
    formatTranscriptLines(rawEvent) {
      return formatCodexTranscriptLines(rawEvent);
    },
    extractFinalResultText(rawEvent) {
      return extractCodexAgentMessageText(rawEvent);
    },
    extractContextMetrics(rawEvent) {
      const tokenCountMetrics = extractCodexTokenCountContext(rawEvent, resolvedContextWindow, brainConfig.codexModel);
      if (tokenCountMetrics) {
        return tokenCountMetrics;
      }

      if (!isRecord(rawEvent) || rawEvent.type !== 'turn.completed') {
        return null;
      }

      const reportedContextWindow = normalizePositiveInteger(rawEvent.model_context_window ?? rawEvent.context_window);
      if (reportedContextWindow === null) {
        return null;
      }

      return {
        modelId: resolveCodexMetricModelId(rawEvent, brainConfig.codexModel),
        contextWindow: reportedContextWindow,
      };
    },
    extractCompactionMetrics(rawEvent) {
      return extractCodexAutoCompaction(rawEvent);
    },
    isResumeSessionError(message) {
      return /(resume|session|conversation|thread)/i.test(message);
    },
  };
}

module.exports = {
  createCodexProvider,
};
