const { normalizeClaudeReasoningEffort } = require('../brain-config.js');

const CLAUDE_OPUS_MODEL = 'claude-opus-4-7[1m]';
const CLAUDE_CACHE_REFRESH_MODEL = 'claude-sonnet-4-6';
const CLAUDE_CACHE_REFRESH_EFFORT = 'high';

function normalizeErrorMessage(message) {
  return typeof message === 'string'
    ? message.trim().toLowerCase()
    : '';
}

function isSessionAlreadyInUseError(message) {
  const normalized = normalizeErrorMessage(message);
  return normalized.includes('already in use')
    && normalized.includes('session');
}

function isProviderApi500Error(message) {
  const normalized = normalizeErrorMessage(message);
  return normalized.includes('api error')
    && normalized.includes('500');
}

function normalizePositiveInteger(value) {
  return Number.isFinite(value) && Number(value) > 0
    ? Math.floor(Number(value))
    : null;
}

function normalizeTokenCount(value) {
  return Number.isFinite(value) && Number(value) >= 0
    ? Math.floor(Number(value))
    : null;
}

function extractClaudeAssistantContext(rawEvent) {
  if (!rawEvent || typeof rawEvent !== 'object' || rawEvent.type !== 'assistant') {
    return null;
  }

  const message = rawEvent.message && typeof rawEvent.message === 'object'
    ? rawEvent.message
    : null;
  const usage = message?.usage && typeof message.usage === 'object'
    ? message.usage
    : null;
  if (!usage) {
    return null;
  }

  const inputTokens = normalizeTokenCount(usage.input_tokens) || 0;
  const outputTokens = normalizeTokenCount(usage.output_tokens) || 0;
  const cacheReadInputTokens = normalizeTokenCount(usage.cache_read_input_tokens) || 0;
  const cacheCreationInputTokens = normalizeTokenCount(usage.cache_creation_input_tokens) || 0;
  const contextTokens = inputTokens + cacheReadInputTokens + cacheCreationInputTokens;
  if (contextTokens <= 0 && outputTokens <= 0) {
    return null;
  }

  return {
    modelId: typeof message.model === 'string' && message.model.trim()
      ? message.model.trim()
      : null,
    contextTokens: contextTokens > 0 ? contextTokens : null,
    contextWindow: null,
    usageSource: 'assistant',
    inputTokens,
    outputTokens,
    cacheReadTokens: cacheReadInputTokens,
    cacheCreateTokens: cacheCreationInputTokens,
  };
}

function extractClaudeModelUsageTokens(usage) {
  if (!usage || typeof usage !== 'object') {
    return null;
  }

  const inputTokens = normalizeTokenCount(usage.inputTokens ?? usage.input_tokens) || 0;
  const outputTokens = normalizeTokenCount(usage.outputTokens ?? usage.output_tokens) || 0;
  const cacheReadTokens = normalizeTokenCount(
    usage.cacheReadInputTokens
      ?? usage.cache_read_input_tokens
      ?? usage.cacheReadTokens
      ?? usage.cache_read_tokens,
  ) || 0;
  const cacheCreateTokens = normalizeTokenCount(
    usage.cacheCreationInputTokens
      ?? usage.cache_creation_input_tokens
      ?? usage.cacheCreateTokens
      ?? usage.cache_create_tokens,
  ) || 0;

  if (inputTokens + outputTokens + cacheReadTokens + cacheCreateTokens <= 0) {
    return null;
  }

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreateTokens,
  };
}

function extractClaudeResultContext(rawEvent) {
  if (!rawEvent || typeof rawEvent !== 'object' || rawEvent.type !== 'result') {
    return null;
  }

  const modelUsage = rawEvent.modelUsage && typeof rawEvent.modelUsage === 'object'
    ? rawEvent.modelUsage
    : null;
  if (!modelUsage) {
    return null;
  }

  let best = null;
  for (const [modelId, usage] of Object.entries(modelUsage)) {
    if (!usage || typeof usage !== 'object') {
      continue;
    }

    const contextWindow = normalizePositiveInteger(usage.contextWindow);
    const usageTokens = extractClaudeModelUsageTokens(usage);
    const normalizedModelId = typeof modelId === 'string' && modelId.trim()
      ? modelId.trim()
      : null;
    if (contextWindow === null && normalizedModelId === null && !usageTokens) {
      continue;
    }

    if (!best || (contextWindow || 0) >= (best.contextWindow || 0)) {
      best = {
        modelId: normalizedModelId,
        contextWindow,
        ...(usageTokens ? {
          usageSource: 'result',
          inputTokens: usageTokens.inputTokens,
          outputTokens: usageTokens.outputTokens,
          cacheReadTokens: usageTokens.cacheReadTokens,
          cacheCreateTokens: usageTokens.cacheCreateTokens,
        } : {}),
      };
    }
  }

  return best;
}

function extractClaudeContextMetrics(rawEvent) {
  return extractClaudeAssistantContext(rawEvent) || extractClaudeResultContext(rawEvent);
}

function extractClaudeCompactBoundary(rawEvent) {
  if (
    !rawEvent
    || typeof rawEvent !== 'object'
    || rawEvent.type !== 'system'
    || rawEvent.subtype !== 'compact_boundary'
  ) {
    return null;
  }

  const compactMetadata = rawEvent.compact_metadata && typeof rawEvent.compact_metadata === 'object'
    ? rawEvent.compact_metadata
    : null;
  if (!compactMetadata) {
    return null;
  }

  const preTokens = normalizePositiveInteger(compactMetadata.pre_tokens);
  const postTokens = normalizePositiveInteger(compactMetadata.post_tokens);

  if (preTokens === null && postTokens === null) {
    return null;
  }

  return {
    preTokens,
    postTokens,
  };
}

function createClaudeProvider(deps, brainConfig) {
  const {
    DEFAULT_CLAUDE_ALLOWED_TOOLS,
    DEFAULT_CLAUDE_CURATION_ALLOWED_TOOLS,
    DEFAULT_CLAUDE_PERMISSION_MODE,
    collectAssistantText,
    extractChatProgressFromEvent,
    extractFinalResultText,
    extractSessionIdFromStreamEvent,
    extractStreamingChatTextFromEvent,
    formatTranscriptLines,
    isCurationTask,
    isFreshAssistantStreamingSignal,
    summarizeStreamingChatEvent,
  } = deps;

  return {
    name: 'claude',
    displayName: 'Claude Code',
    binaryName: 'claude',
    config: brainConfig,
    buildAvailabilityCheck() {
      return {
        command: 'claude',
        args: ['--version'],
      };
    },
    supportsManualCompaction() {
      return true;
    },
    buildInvocation({ prompt, systemPrompt, task, sessionMode }) {
      const allowedTools = (isCurationTask?.(task)
        || task?.priority === 'cache_refresh'
        || task?.metadata?.requiresBrowserTools === true)
        ? DEFAULT_CLAUDE_CURATION_ALLOWED_TOOLS
        : DEFAULT_CLAUDE_ALLOWED_TOOLS;
      const useRuntimeSettingSources = typeof task?.priority === 'string';
      const args = [
        '-p',
        prompt,
      ];

      if (useRuntimeSettingSources) {
        args.push('--setting-sources', 'user,project');
      }

      args.push(
        '--allowedTools',
        allowedTools,
        '--permission-mode',
        DEFAULT_CLAUDE_PERMISSION_MODE,
        '--append-system-prompt',
        systemPrompt,
        '--output-format',
        'stream-json',
        '--include-partial-messages',
        '--verbose',
      );

      const isCacheRefreshTask = task.priority === 'cache_refresh';
      const isPostEnrichmentTask = task.priority === 'post_enrichment';
      const useOpus = task.priority === 'user_ping'
        || task.priority === 'user_chat';
      const requestedReasoning = task?.metadata && typeof task.metadata === 'object'
        ? task.metadata.claudeReasoningEffort
        : null;
      const sessionReasoning = normalizeClaudeReasoningEffort(
        typeof requestedReasoning === 'string' && requestedReasoning.trim()
          ? requestedReasoning
          : brainConfig.claudeReasoningEffort,
      );

      if (isCacheRefreshTask) {
        // 2026-05-06 manual Sonnet-low benchmark (Twitter only, single run):
        //   22 tweets, 100% avatar, 77% media, 0/22 quote (no quotes in feed sample),
        //   $0.98, 138s. Compared with Apr 25 Sonnet-no-effort ($1.29/437s/14 tweets):
        //   Sonnet-low is faster, cheaper, captures more tweets at equivalent quality.
        //   Sonnet-medium ran at $1.59/317s - strictly worse than low for this workload.
        //   Tier maps: Low -> low (cost-sensitive), Medium/High -> high (calibrated Apr 27).
        // Cache browsing is hidden background work. On 2026-04-27, production-shaped
        // calibration kept prompt/tools/session mode fixed and changed only model/effort.
        // YouTube: 213 items/176s/$0.49 vs Opus 214/162s/$1.52.
        // Twitter: 171/375s/$1.10 and 161/357s/$1.37 vs Opus 184/322s/$2.05.
        // Substack: 23/257s/$0.85 vs latest Opus 12/156s/$1.88; 24h Opus avg was noisy at 61 items.
        // Hacker News is the known exception: 67/286s/$0.99 vs Opus 67/34s/$0.44.
        // Four-source batch: 464 items/$3.70 vs closest Opus 477/$5.89, about 37% cheaper.
        args.push('--model', CLAUDE_CACHE_REFRESH_MODEL);
        args.push('--effort', brainConfig.cacheRefreshEffort || CLAUDE_CACHE_REFRESH_EFFORT);
      } else if (isPostEnrichmentTask) {
        // 2026-05-06 manual Sonnet-low post-enrichment benchmark (single karpathy reply thread):
        //   15/15 replies captured, 15/15 reply avatars populated, $1.10, 190s.
        //   Sonnet-low handles reply-avatar capture cleanly when the prompt is explicit
        //   about lazy-load handling. Tier maps: Low -> low, Medium/High -> high.
        // Post enrichment is per-item hot-path work after curation cycles. On 2026-04-29,
        // production-shaped calibration kept buildEnrichmentPrompt input/tools/permission
        // mode fixed and changed only model/effort across six distinct top-level tweets,
        // including two shape-matched pairs.
        // Opus 4.7 1M + high: 3 items averaged about $4.22/item and 68s; 3/3 made
        // meaningful changes.
        // Sonnet 4.6 + high: 3 items averaged about $0.84/item and 104s; 2/3 made
        // meaningful changes, and 1/3 was a correct no-op on an already-enriched field.
        // Net: Sonnet was about 5x cheaper, and the cleanest identical-shape paired
        // comparisons were output-indistinguishable.
        args.push('--model', CLAUDE_CACHE_REFRESH_MODEL);
        args.push('--effort', brainConfig.postEnrichmentEffort || CLAUDE_CACHE_REFRESH_EFFORT);
      } else if (useOpus) {
        args.push('--model', brainConfig.curatorModel || CLAUDE_OPUS_MODEL);
        args.push('--effort', sessionReasoning);
      }

      if (sessionMode?.mode === 'resume') {
        args.push('--resume', sessionMode.sessionId);
      } else if (sessionMode?.mode === 'new') {
        args.push('--session-id', sessionMode.sessionId);
      } else {
        args.push('--no-session-persistence');
      }

      return {
        command: 'claude',
        args,
        env: {
          CLAUDECODE: '',
        },
      };
    },
    buildCompactionInvocation({ sessionId }) {
      return {
        command: 'claude',
        args: [
          '-p',
          '/compact',
          '--resume',
          sessionId,
          '--output-format',
          'stream-json',
          '--include-partial-messages',
          '--verbose',
        ],
        env: {
          CLAUDECODE: '',
        },
      };
    },
    extractSessionId(rawEvent) {
      return extractSessionIdFromStreamEvent(rawEvent);
    },
    isFreshAssistantStreamingSignal(rawEvent) {
      return isFreshAssistantStreamingSignal(rawEvent);
    },
    collectAssistantText(rawEvent) {
      return collectAssistantText(rawEvent);
    },
    extractStreamingChatText(rawEvent, context) {
      return extractStreamingChatTextFromEvent(rawEvent, context.toolUseBlocks, context.expectedInReplyTo);
    },
    summarizeEvent(rawEvent) {
      return summarizeStreamingChatEvent(rawEvent);
    },
    extractChatProgress(rawEvent, context) {
      return extractChatProgressFromEvent(rawEvent, context.toolUseBlocks);
    },
    formatTranscriptLines(rawEvent) {
      return formatTranscriptLines(rawEvent);
    },
    extractFinalResultText(rawEvent) {
      return extractFinalResultText(rawEvent);
    },
    extractContextMetrics(rawEvent) {
      return extractClaudeContextMetrics(rawEvent);
    },
    extractCompactionMetrics(rawEvent) {
      return extractClaudeCompactBoundary(rawEvent);
    },
    isResumeSessionError(message) {
      return /(resume|session|conversation)/i.test(message);
    },
    isSessionPoisoningError(message, context = {}) {
      if (isSessionAlreadyInUseError(message)) {
        return true;
      }

      return isProviderApi500Error(message)
        && (context?.hadToolUse === true || context?.hadPartialProgress === true);
    },
  };
}

module.exports = {
  createClaudeProvider,
};
