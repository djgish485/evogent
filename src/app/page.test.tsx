import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatAttachmentCard } from '@/components/chat/chat-attachment-card';
import { BrainProviderSwitcherModal, SidebarAutomationControls } from '@/components/chat/chat-control-panels';
import { CHAT_COMPOSER_FORM_TEXT_ENTRY_ATTRIBUTES, CHAT_COMPOSER_TEXTBOX_TEXT_ENTRY_ATTRIBUTES, shouldSubmitChatComposerKeyDown } from '@/lib/chat-composer-helpers';
import { getChatMessageAuthorLabel, mergeComposerAttachments } from '@/lib/chat-messages';
import { buildConversationPreviewMessages, buildConversationPreviewText } from '@/lib/conversation-summary';
import { appendFeedFilterToFeedQuery, buildBaseFeedFilters, buildDynamicFeedSourceFilters, hasTweetFeedSource, resolveFeedFilterClickAction } from '@/lib/feed-filters';
import { getOldestLoadedPrimaryFeedItemTimestamp, shouldIncludeConversationTimelineEntry, shouldRenderFeedEmptyState } from '@/lib/feed-normalize';
import { canOpenChatSessionCompactPopover, formatCompactTokenCount, getChatSessionCompactButtonState, getChatSessionContextHeaderMetrics, getChatSessionHeaderProviderLabel, getCodexBrowserToolsStatus, getProviderModelDisplayName } from '@/lib/brain-provider';
import { deriveCodexReasoningEffortFromConfig, formatCodexReasoningEffortLabel } from '@/lib/reasoning-effort';
import { resolveSuggestionChatDestination } from '@/lib/suggestion-routing';
import {
  getChatComposerTransferFiles,
  isChatComposerFileTransfer,
  uploadChatAttachmentFiles,
} from '@/lib/chat-composer-attachments';
import type { ChatAttachment, ChatMessage } from '@/types/chat';
import type { FeedItem, FeedItemType } from '@/types/feed';

function buildFeedItem(overrides: Partial<FeedItem> & { id: string; type: FeedItemType; createdAt: string }): FeedItem {
  return {
    id: overrides.id,
    type: overrides.type,
    source: overrides.source ?? null,
    sourceId: overrides.sourceId ?? null,
    originSessionId: overrides.originSessionId ?? null,
    parentId: overrides.parentId ?? null,
    relationship: overrides.relationship ?? null,
    title: overrides.title ?? null,
    text: overrides.text ?? 'Item text',
    url: overrides.url ?? null,
    excerpt: overrides.excerpt ?? null,
    authorUsername: overrides.authorUsername ?? null,
    authorDisplayName: overrides.authorDisplayName ?? null,
    reason: overrides.reason ?? null,
    tags: overrides.tags ?? [],
    mediaUrls: overrides.mediaUrls ?? [],
    metrics: overrides.metrics ?? { likes: 0, reposts: 0, replies: 0 },
    authorAvatarUrl: overrides.authorAvatarUrl ?? null,
    isLiked: overrides.isLiked ?? false,
    isDisliked: overrides.isDisliked ?? false,
    suggestionStatus: overrides.suggestionStatus,
    parentItem: overrides.parentItem,
    children: overrides.children,
    childrenCount: overrides.childrenCount,
    suggestionChildren: overrides.suggestionChildren,
    analysisPresentation: overrides.analysisPresentation ?? null,
    notificationTaskContext: overrides.notificationTaskContext ?? null,
    metadata: overrides.metadata ?? null,
    publishedAt: overrides.publishedAt ?? overrides.createdAt,
    createdAt: overrides.createdAt,
  };
}

function buildChatMessage(overrides: Partial<ChatMessage> & { id: string; text: string; timestamp: string }): ChatMessage {
  return {
    type: overrides.type ?? 'chat',
    id: overrides.id,
    role: overrides.role ?? 'user',
    inReplyTo: overrides.inReplyTo ?? null,
    sessionId: overrides.sessionId ?? 'session-1',
    text: overrides.text,
    timestamp: overrides.timestamp,
    context: overrides.context ?? null,
    status: overrides.status ?? null,
    metadata: overrides.metadata ?? null,
    createdAt: overrides.createdAt ?? overrides.timestamp,
  };
}

describe('dynamic feed source filters', () => {
  test('shows only app-native filters before source or curator capability exists', () => {
    assert.deepStrictEqual(
      buildBaseFeedFilters({ hasTweetSource: false, hasCuratorSession: false }).map((filter) => filter.value),
      ['all', 'agent', 'suggestion', 'notification'],
    );
  });

  test('adds tweet from source metadata and curation filters from curator sessions', () => {
    assert.strictEqual(hasTweetFeedSource([{ value: 'x.com', label: 'X' }]), true);
    assert.deepStrictEqual(
      buildBaseFeedFilters({ hasTweetSource: true, hasCuratorSession: true }).map((filter) => filter.value),
      ['all', 'agent', 'suggestion', 'tweet', 'article', 'analysis', 'notification'],
    );
  });

  test('builds source filters from installed skill metadata without hard-coded source names', () => {
    const filters = buildDynamicFeedSourceFilters([
      { value: 'twitter', label: 'Twitter' },
      { value: 'x.com', label: 'X' },
      { value: 'substack', label: 'Substack' },
      { value: 'youtube', label: 'YouTube' },
      { value: 'hackernews', label: 'Hacker News' },
    ]);

    assert.deepStrictEqual(
      filters.map((filter) => ({ value: filter.value, label: filter.label, testId: filter.testId })),
      [
        { value: 'substack', label: 'Substack', testId: 'type-filter-substack' },
        { value: 'youtube', label: 'YouTube', testId: 'type-filter-youtube' },
        { value: 'hackernews', label: 'Hacker News', testId: 'type-filter-hackernews' },
      ],
    );
  });

  test('source-backed article feeds remain separate from the generic Article filter', () => {
    const sourceFilters = buildDynamicFeedSourceFilters([
      { value: 'article', label: 'Article' },
      { value: 'substack', label: 'Substack' },
    ]);

    assert.deepStrictEqual(sourceFilters.map((filter) => filter.value), ['substack']);
  });

  test('source filters query /api/feed by source while type filters query by type', () => {
    const sourceFilters = new Set(['substack']);
    const sourceQuery = new URLSearchParams();
    appendFeedFilterToFeedQuery(sourceQuery, 'substack', sourceFilters);
    assert.strictEqual(sourceQuery.toString(), 'source=substack');

    const typeQuery = new URLSearchParams();
    appendFeedFilterToFeedQuery(typeQuery, 'article', sourceFilters);
    assert.strictEqual(typeQuery.toString(), 'type=article');
  });
});

describe('conversation search previews', () => {
  test('uses matching messages instead of the latest messages when search is active', () => {
    const messages = [
      buildChatMessage({
        id: 'old-match',
        text: 'This earlier message mentions the hidden needle.',
        timestamp: '2026-04-25T12:00:00.000Z',
      }),
      buildChatMessage({
        id: 'recent-one',
        text: 'Recent unrelated message.',
        timestamp: '2026-04-25T12:01:00.000Z',
      }),
      buildChatMessage({
        id: 'recent-two',
        text: 'Another recent unrelated message.',
        timestamp: '2026-04-25T12:02:00.000Z',
      }),
      buildChatMessage({
        id: 'recent-three',
        text: 'Newest unrelated message.',
        timestamp: '2026-04-25T12:03:00.000Z',
      }),
    ];

    assert.deepStrictEqual(
      buildConversationPreviewMessages(messages, 'needle').map((message) => message.id),
      ['old-match'],
    );
  });

  test('builds a snippet around the matching chat text', () => {
    const message = buildChatMessage({
      id: 'long-match',
      text: `${'intro '.repeat(40)}needle appears near the middle of a long message${' outro'.repeat(40)}`,
      timestamp: '2026-04-25T12:00:00.000Z',
    });

    const preview = buildConversationPreviewText(message, 'needle');
    assert.match(preview, /^\.\.\./);
    assert.match(preview, /needle appears/);
    assert.ok(preview.length <= 160);
  });
});

describe('chat session header provider labels', () => {
  test('renders the Claude provider and model name with a middot separator', () => {
    assert.strictEqual(getProviderModelDisplayName('claude'), 'Opus 4.7');
    assert.strictEqual(getChatSessionHeaderProviderLabel('claude'), 'Claude Code · Opus 4.7');
  });

  test('renders the Codex provider and model name with a middot separator', () => {
    assert.strictEqual(getProviderModelDisplayName('codex'), 'GPT-5.5');
    assert.strictEqual(getChatSessionHeaderProviderLabel('codex'), 'Codex · GPT-5.5');
  });

  test('formats compact token counts for the header badge', () => {
    assert.strictEqual(formatCompactTokenCount(999), '999');
    assert.strictEqual(formatCompactTokenCount(564_000), '564K');
    assert.strictEqual(formatCompactTokenCount(1_000_000), '1M');
  });

  test('formats Codex xhigh reasoning for header badges', () => {
    assert.strictEqual(formatCodexReasoningEffortLabel('xhigh'), 'XHigh');
  });

  test('derives missing Codex reasoning from usage level for provider UI defaults', () => {
    assert.strictEqual(deriveCodexReasoningEffortFromConfig('## Usage Level\nLow\n'), 'low');
    assert.strictEqual(deriveCodexReasoningEffortFromConfig('## Usage Level\nMedium\n'), 'medium');
    assert.strictEqual(deriveCodexReasoningEffortFromConfig('## Usage Level\nHigh\n'), 'high');
  });

  test('keeps explicit Codex reasoning for provider UI defaults', () => {
    assert.strictEqual(deriveCodexReasoningEffortFromConfig(`
## Usage Level
Low

## Codex Reasoning Effort
XHigh
`), 'xhigh');
  });

  test('renders Codex context metrics in the session header when metrics are persisted', () => {
    const metrics = getChatSessionContextHeaderMetrics({
      provider: 'codex',
      latestContextTokens: 174_104,
      latestContextWindow: 258_400,
      latestContextModel: 'gpt-5.5',
    });

    assert.deepStrictEqual(metrics && {
      contextTokens: metrics.contextTokens,
      limit: metrics.limit,
      utilizationPercent: metrics.utilizationPercent,
      status: metrics.status,
    }, {
      contextTokens: 174_104,
      limit: 258_400,
      utilizationPercent: 67,
      status: 'warn',
    });
  });

  test('opens the context details popover for Codex sessions with valid metrics', () => {
    assert.strictEqual(canOpenChatSessionCompactPopover({
      provider: 'codex',
      latestContextTokens: 177_111,
      latestContextWindow: 258_400,
      latestContextModel: 'gpt-5.5',
    }), true);
  });

  test('keeps the context details popover closed for invalid Codex cumulative metrics', () => {
    assert.strictEqual(canOpenChatSessionCompactPopover({
      provider: 'codex',
      latestContextTokens: 3_531_600,
      latestContextWindow: 1_000_000,
      latestContextModel: 'gpt-5.5',
    }), false);
  });

  test('disables Codex compact with provider-accurate copy until the CLI supports it', () => {
    assert.deepStrictEqual(getChatSessionCompactButtonState({
      provider: 'codex',
      phase: null,
      hasActiveChatTurn: false,
    }), {
      disabled: true,
      label: 'Unavailable',
      title: 'Codex CLI manual compact is not supported yet.',
      unavailableReason: 'Codex CLI manual compact is not supported yet.',
    });
  });

  test('keeps Claude compact available and queue-aware', () => {
    assert.deepStrictEqual(getChatSessionCompactButtonState({
      provider: 'claude',
      phase: null,
      hasActiveChatTurn: false,
    }), {
      disabled: false,
      label: 'Compact',
      title: 'Compact this session to replace long history with a shorter summary.',
      unavailableReason: null,
    });

    assert.deepStrictEqual(getChatSessionCompactButtonState({
      provider: 'claude',
      phase: null,
      hasActiveChatTurn: true,
    }), {
      disabled: false,
      label: 'Compact',
      title: 'Compact will queue and start when the current chat turn finishes.',
      unavailableReason: null,
    });
  });

  test('renders Codex browser-tool diagnostics separately from CLI availability', () => {
    const codexAvailability = {
      provider: 'codex' as const,
      providerDisplayName: 'Codex CLI',
      providerBinary: 'codex',
      available: true,
      version: 'codex-cli 0.125.0',
      error: null,
      diagnostics: {
        browserTools: {
          ok: false,
          checkedAt: '2026-04-07T00:00:00.000Z',
          expectedCdpUrl: 'http://127.0.0.1:9222',
          configuredCdpUrl: null,
          serverName: null,
          reason: 'playwright_missing',
          message: 'Codex browser prerequisites missing: configure an enabled Playwright MCP server for Codex that targets http://127.0.0.1:9222.',
        },
      },
    };

    assert.deepStrictEqual(getCodexBrowserToolsStatus(codexAvailability), {
      ok: false,
      label: 'Missing',
      message: 'Missing Playwright MCP server "playwright" for shared Chrome CDP http://127.0.0.1:9222.',
      action: 'Codex MCP setup: add server "playwright" with node scripts/start-playwright-mcp.js so it targets http://127.0.0.1:9222.',
    });

    const markup = renderToStaticMarkup(createElement(BrainProviderSwitcherModal, {
      open: true,
      status: {
        currentProvider: 'codex',
        currentProviderLabel: 'Codex CLI',
        codexReasoningEffort: 'high',
        providers: {
          claude: {
            provider: 'claude',
            providerDisplayName: 'Claude Code',
            providerBinary: 'claude',
            available: false,
            version: null,
            error: 'claude missing',
          },
          codex: codexAvailability,
        },
        isProcessing: false,
        currentTask: null,
        queueDepth: 0,
        checkedAt: '2026-04-07T00:00:00.000Z',
      },
      error: null,
      isLoading: false,
      isSubmitting: false,
      targetProvider: 'codex',
      codexReasoningEffort: 'high',
      onClose: () => {},
      onTargetProviderChange: () => {},
      onCodexReasoningEffortChange: () => {},
      onSubmit: () => {},
    }));

    assert.match(markup, /CLI Available/);
    assert.match(markup, /codex-cli 0\.125\.0/);
    assert.match(markup, /Browser tools: Missing/);
    assert.match(markup, /Missing Playwright MCP server &quot;playwright&quot; for shared Chrome CDP http:\/\/127\.0\.0\.1:9222\./);
    assert.match(markup, /Codex MCP setup: add server &quot;playwright&quot; with node scripts\/start-playwright-mcp\.js/);
  });

  test('labels post-merge review user turns as code fix callbacks', () => {
    assert.strictEqual(
      getChatMessageAuthorLabel({
        role: 'user',
        metadata: { source: 'post_merge_review' },
      }, 'Claude'),
      'Code fix callback',
    );
    assert.strictEqual(
      getChatMessageAuthorLabel({
        role: 'user',
        metadata: { source: 'post_merge_review' },
        status: 'cancelled',
      }, 'Claude'),
      'Code fix callback • Cancelled',
    );
    assert.strictEqual(
      getChatMessageAuthorLabel({
        role: 'user',
        metadata: null,
      }, 'Claude'),
      'You',
    );
  });
});

describe('feed filter click actions', () => {
  test('scrolls visible feed to top when the active filter is clicked again', () => {
    assert.deepStrictEqual(
      resolveFeedFilterClickAction({
        selectedFilter: 'all',
        nextFilter: 'all',
        isFeedSurfaceVisible: true,
      }),
      {
        shouldUpdateFilter: false,
        shouldScrollFeedToTop: true,
      },
    );
  });

  test('updates inactive filter clicks without immediate scroll', () => {
    assert.deepStrictEqual(
      resolveFeedFilterClickAction({
        selectedFilter: 'all',
        nextFilter: 'tweet',
        isFeedSurfaceVisible: true,
      }),
      {
        shouldUpdateFilter: true,
        shouldScrollFeedToTop: false,
      },
    );
  });

  test('does not scroll hidden feed when active filter is clicked behind another view', () => {
    assert.deepStrictEqual(
      resolveFeedFilterClickAction({
        selectedFilter: 'all',
        nextFilter: 'all',
        isFeedSurfaceVisible: false,
      }),
      {
        shouldUpdateFilter: false,
        shouldScrollFeedToTop: false,
      },
    );
  });
});

describe('feed conversation timeline composition', () => {
  test('includes default blank agent sessions in All when no primary feed boundary exists', () => {
    assert.strictEqual(getOldestLoadedPrimaryFeedItemTimestamp([], () => true), null);
    assert.strictEqual(
      shouldIncludeConversationTimelineEntry({
        selectedFilter: 'all',
        oldestLoadedPrimaryFeedItemTimestamp: null,
        conversationLastTimestamp: '2026-04-28T10:00:00.000Z',
      }),
      true,
    );
    assert.strictEqual(
      shouldRenderFeedEmptyState({ isLoading: false, visibleFeedEntryCount: 2 }),
      false,
    );
  });

  test('keeps mixed All pagination bounded once primary feed items are loaded', () => {
    const oldestLoadedPrimaryFeedItemTimestamp = getOldestLoadedPrimaryFeedItemTimestamp([
      buildFeedItem({
        id: 'tweet-new',
        type: 'tweet',
        createdAt: '2026-04-28T10:00:00.000Z',
      }),
      buildFeedItem({
        id: 'suggestion-old',
        type: 'suggestion',
        createdAt: '2026-04-28T08:00:00.000Z',
      }),
      buildFeedItem({
        id: 'article-oldest-primary',
        type: 'article',
        createdAt: '2026-04-28T09:00:00.000Z',
      }),
    ], () => true);

    assert.strictEqual(oldestLoadedPrimaryFeedItemTimestamp, '2026-04-28T09:00:00.000Z');
    assert.strictEqual(
      shouldIncludeConversationTimelineEntry({
        selectedFilter: 'all',
        oldestLoadedPrimaryFeedItemTimestamp,
        conversationLastTimestamp: '2026-04-28T09:30:00.000Z',
      }),
      true,
    );
    assert.strictEqual(
      shouldIncludeConversationTimelineEntry({
        selectedFilter: 'all',
        oldestLoadedPrimaryFeedItemTimestamp,
        conversationLastTimestamp: '2026-04-28T08:30:00.000Z',
      }),
      false,
    );
  });

  test('does not apply the primary feed cutoff in the Agent filter', () => {
    assert.strictEqual(
      shouldIncludeConversationTimelineEntry({
        selectedFilter: 'agent',
        oldestLoadedPrimaryFeedItemTimestamp: '2026-04-28T09:00:00.000Z',
        conversationLastTimestamp: '2026-04-28T08:30:00.000Z',
      }),
      true,
    );
  });
});

describe('suggestion chat routing', () => {
  test('routes a suggestion with an available origin session back to that chat', () => {
    const item = buildFeedItem({
      id: 'code-fix-origin',
      type: 'suggestion',
      originSessionId: 'origin-session',
      createdAt: '2026-04-28T10:00:00.000Z',
      metadata: {
        suggestionType: 'code_fix',
        proposedValue: 'Open the original chat.',
      },
    });

    assert.deepStrictEqual(
      resolveSuggestionChatDestination({
        items: [item],
        conversationSessions: [{ sessionId: 'origin-session' }],
        targetSessionId: 'current-session',
      }),
      {
        mode: 'origin',
        sessionId: 'origin-session',
      },
    );
  });

  test('falls back to the current chat with enrichment source context when no origin exists', () => {
    const item = buildFeedItem({
      id: 'code-fix-enrichment',
      type: 'suggestion',
      originSessionId: null,
      sourceId: 'code-fix:feed-1:missing-feature',
      createdAt: '2026-04-28T10:00:00.000Z',
      metadata: {
        suggestionType: 'code_fix',
        proposedValue: 'Persist the missing feature.',
        feedIds: ['feed-1'],
        sourceUrls: ['https://example.com/source'],
      },
    });

    const decision = resolveSuggestionChatDestination({
      items: [item],
      conversationSessions: [{ sessionId: 'current-session' }],
      targetSessionId: 'current-session',
    });

    assert.strictEqual(decision.mode, 'fallback');
    assert.strictEqual(decision.sessionId, 'current-session');
    assert.match(decision.reason, /does not have an origin chat session/);
    assert.match(decision.reason, /enrichment pipeline/);
    assert.match(decision.reason, /feed-1 \/ https:\/\/example\.com\/source/);
  });

  test('falls back when an origin session id is no longer in the loaded sessions', () => {
    const item = buildFeedItem({
      id: 'code-fix-missing-origin',
      type: 'suggestion',
      originSessionId: 'missing-origin-session',
      createdAt: '2026-04-28T10:00:00.000Z',
      metadata: {
        suggestionType: 'code_fix',
        proposedValue: 'Handle missing origins.',
      },
    });

    const decision = resolveSuggestionChatDestination({
      items: [item],
      conversationSessions: [{ sessionId: 'current-session' }],
      targetSessionId: 'current-session',
    });

    assert.strictEqual(decision.mode, 'fallback');
    assert.strictEqual(decision.sessionId, 'current-session');
    assert.match(decision.reason, /missing-origin-session/);
    assert.match(decision.reason, /not currently available/);
  });

  test('only routes grouped suggestions to origin when they share one available session', () => {
    const first = buildFeedItem({
      id: 'code-fix-group-a',
      type: 'suggestion',
      originSessionId: 'origin-session',
      createdAt: '2026-04-28T10:00:00.000Z',
      metadata: {
        suggestionType: 'code_fix',
        proposedValue: 'First fix.',
      },
    });
    const second = buildFeedItem({
      id: 'code-fix-group-b',
      type: 'suggestion',
      originSessionId: 'other-origin-session',
      createdAt: '2026-04-28T10:01:00.000Z',
      metadata: {
        suggestionType: 'code_fix',
        proposedValue: 'Second fix.',
      },
    });

    assert.deepStrictEqual(
      resolveSuggestionChatDestination({
        items: [{ ...first, id: 'code-fix-group-c' }, first],
        conversationSessions: [{ sessionId: 'origin-session' }],
        targetSessionId: 'current-session',
      }),
      {
        mode: 'origin',
        sessionId: 'origin-session',
      },
    );

    const mixedDecision = resolveSuggestionChatDestination({
      items: [first, second],
      conversationSessions: [
        { sessionId: 'origin-session' },
        { sessionId: 'other-origin-session' },
      ],
      targetSessionId: 'current-session',
    });

    assert.strictEqual(mixedDecision.mode, 'fallback');
    assert.strictEqual(mixedDecision.sessionId, 'current-session');
    assert.match(mixedDecision.reason, /do not share one available origin chat session/);
  });
});

describe('chat composer text entry', () => {
  test('allows native spelling assistance while preserving password-manager suppression', () => {
    const markup = renderToStaticMarkup(createElement(
      'form',
      CHAT_COMPOSER_FORM_TEXT_ENTRY_ATTRIBUTES,
      createElement('div', {
        ...CHAT_COMPOSER_TEXTBOX_TEXT_ENTRY_ATTRIBUTES,
        contentEditable: true,
        role: 'textbox',
      }),
    ));

    assert.match(markup, /role="textbox"/);
    assert.match(markup, /spellcheck="true"/i);
    assert.match(markup, /autocorrect="on"/i);
    assert.match(markup, /autocapitalize="sentences"/i);
    assert.match(markup, /data-form-type="other"/);
    assert.match(markup, /data-lpignore="true"/);
    assert.doesNotMatch(markup, /spellcheck="false"/i);
    assert.doesNotMatch(markup, /autocorrect="off"/i);
    assert.doesNotMatch(markup, /autocapitalize="off"/i);
  });

  test('keeps Enter and modifier-Enter submission behavior unchanged', () => {
    assert.strictEqual(shouldSubmitChatComposerKeyDown({
      key: 'Enter',
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      isMobileViewport: false,
    }), true);
    assert.strictEqual(shouldSubmitChatComposerKeyDown({
      key: 'Enter',
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      isMobileViewport: false,
    }), true);
    assert.strictEqual(shouldSubmitChatComposerKeyDown({
      key: 'Enter',
      metaKey: false,
      ctrlKey: true,
      shiftKey: false,
      isMobileViewport: true,
    }), true);
    assert.strictEqual(shouldSubmitChatComposerKeyDown({
      key: 'Enter',
      metaKey: false,
      ctrlKey: false,
      shiftKey: true,
      isMobileViewport: false,
    }), false);
    assert.strictEqual(shouldSubmitChatComposerKeyDown({
      key: 'Enter',
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      isMobileViewport: true,
    }), false);
    assert.strictEqual(shouldSubmitChatComposerKeyDown({
      key: 'a',
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      isMobileViewport: false,
    }), false);
  });
});

describe('sidebar automation controls', () => {
  test('renders background browsing switch without retired automatic curation controls', () => {
    const markup = renderToStaticMarkup(createElement(SidebarAutomationControls, {
      backgroundSourceBrowsingEnabled: true,
      timeZoneLabel: 'America/Denver',
      timeZoneWarning: null,
      openClawDailyTimer: null,
      configLoaded: true,
      isSavingBackgroundSourceBrowsing: false,
      isRepairingOpenClawDailyTimer: false,
      isStartingSourceHealth: false,
      backgroundSourceBrowsingError: null,
      openClawDailyTimerError: null,
      onToggleBackgroundSourceBrowsing: () => {},
      onRepairOpenClawDailyTimer: () => {},
      onStartSourceHealth: () => {},
    }));

    assert.match(markup, /Background Browsing/);
    assert.doesNotMatch(markup, /Automatic curation/);
    assert.doesNotMatch(markup, /data-testid="automatic-curation-toggle"/);
    assert.match(markup, /data-testid="background-source-browsing-toggle"/);
    assert.match(markup, /data-testid="source-health-button"/);
    assert.match(markup, /aria-label="Toggle background browsing"/);
    assert.doesNotMatch(markup, /aria-label="View automatic curation details"/);
    assert.match(markup, /aria-label="View background browsing details"/);
    assert.match(markup, /class="contents"/);
    assert.match(markup, /p-1\.5/);
    assert.match(markup, /h-4 w-4/);
    assert.doesNotMatch(markup, /h-8 w-8/);
    assert.match(markup, /Source Health/);
    assert.match(markup, /Time Zone/);
    assert.match(markup, /America\/Denver/);
    assert.doesNotMatch(markup, /Adaptive heartbeat pauses when off\. Manual refresh still works\./);
    assert.doesNotMatch(markup, /Keeps new source items ready for curation\./);
    assert.doesNotMatch(markup, />On</);
    assert.doesNotMatch(markup, />Off</);
    assert.doesNotMatch(markup, /Manual refresh and setup still work/);
  });

  test('renders the background browsing switch without an off label when disabled', () => {
    const markup = renderToStaticMarkup(createElement(SidebarAutomationControls, {
      backgroundSourceBrowsingEnabled: false,
      timeZoneLabel: 'America/Denver',
      timeZoneWarning: null,
      openClawDailyTimer: null,
      configLoaded: true,
      isSavingBackgroundSourceBrowsing: false,
      isRepairingOpenClawDailyTimer: false,
      isStartingSourceHealth: false,
      backgroundSourceBrowsingError: null,
      openClawDailyTimerError: null,
      onToggleBackgroundSourceBrowsing: () => {},
      onRepairOpenClawDailyTimer: () => {},
      onStartSourceHealth: () => {},
    }));

    assert.match(markup, /aria-label="Toggle background browsing"/);
    assert.match(markup, /aria-checked="false"/);
    assert.doesNotMatch(markup, />Off</);
  });
});

describe('chat composer attachments', () => {
  test('detects file transfers without hijacking non-file drops', () => {
    const file = new File(['image'], 'screenshot.png', { type: 'image/png' });

    assert.strictEqual(isChatComposerFileTransfer({ files: [], types: ['text/plain'] }), false);
    assert.deepStrictEqual(getChatComposerTransferFiles({ files: [], types: ['text/plain'] }), []);

    assert.strictEqual(isChatComposerFileTransfer({ files: [], types: ['Files'] }), true);
    assert.deepStrictEqual(getChatComposerTransferFiles({ files: [file], types: ['Files'] }), [file]);
  });

  test('uploads dropped files through the existing chat upload endpoint', async () => {
    const file = new File(['image'], 'screenshot.png', { type: 'image/png' });
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit; file: File | null }> = [];

    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body as FormData;
      const uploadedFile = body.get('file') as File | null;
      requests.push({ input, init, file: uploadedFile });

      return new Response(JSON.stringify({
        filePath: '/tmp/evogent-validation/chat-attachments/attachment-1.png',
        fileName: 'attachment-1.png',
        originalName: uploadedFile?.name ?? 'unknown',
        contentType: uploadedFile?.type ?? 'application/octet-stream',
        size: uploadedFile?.size ?? 0,
        previewUrl: '/api/chat/upload?file=attachment-1.png',
        kind: 'image',
      } satisfies ChatAttachment), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const result = await uploadChatAttachmentFiles([file], fetcher);

    assert.strictEqual(requests.length, 1);
    assert.strictEqual(requests[0].input, '/api/chat/upload');
    assert.strictEqual(requests[0].init?.method, 'POST');
    assert.strictEqual(requests[0].file, file);
    assert.strictEqual(result.failures.length, 0);
    assert.strictEqual(result.uploaded[0].originalName, 'screenshot.png');
  });

  test('returns upload failures so the composer can surface the existing error path', async () => {
    const file = new File(['binary'], 'tool.exe', { type: 'application/octet-stream' });
    const fetcher = (async () => new Response(JSON.stringify({
      error: 'Unsupported file type',
    }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

    const result = await uploadChatAttachmentFiles([file], fetcher);

    assert.deepStrictEqual(result.uploaded, []);
    assert.deepStrictEqual(result.failures, ['Unsupported file type']);
  });

  test('keeps attachment dedup and preview rendering unchanged after upload', () => {
    const firstAttachment: ChatAttachment = {
      filePath: '/tmp/evogent-validation/chat-attachments/attachment-1.png',
      fileName: 'attachment-1.png',
      originalName: 'screenshot.png',
      contentType: 'image/png',
      size: 5,
      previewUrl: '/api/chat/upload?file=attachment-1.png',
      kind: 'image',
    };
    const replacementAttachment: ChatAttachment = {
      ...firstAttachment,
      originalName: 'renamed-screenshot.png',
    };

    assert.deepStrictEqual(
      mergeComposerAttachments([firstAttachment], [replacementAttachment]),
      [replacementAttachment],
    );

    const markup = renderToStaticMarkup(createElement(ChatAttachmentCard, {
      attachment: replacementAttachment,
    }));

    assert.match(markup, /renamed-screenshot\.png/);
    assert.match(markup, /\/api\/chat\/upload\?file=attachment-1\.png/);
  });
});
