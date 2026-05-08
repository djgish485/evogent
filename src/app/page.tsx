'use client';

import { ChatAttachmentCard } from '@/components/chat/chat-attachment-card';
import { BrainProviderSwitcherModal, ChatCurationStatusBanner, CodeFixReasoningSwitcherModal, CurationTaskCard, FeedEmptyLoadingState, SidebarAutomationControls, SidebarCodeFixReasoningButton, UsageSummaryModal, useUsageSummaryLabels } from '@/components/chat/chat-control-panels';
import { ChatStopButton, ChatWorkingIndicator } from '@/components/chat/chat-working-indicator';
import { CuratorCurateButtons } from '@/components/chat/curator-curate-buttons';
import { NewSessionModal } from '@/components/chat/new-session-modal';
import { ConfigPanel } from '@/components/config-panel';
import { AnalysisSeriesCard } from '@/components/feed/analysis-series-card';
import { CompactInfoPopover } from '@/components/feed/compact-info-popover';
import { ContentCard } from '@/components/feed/content-card';
import { GroupDetailView } from '@/components/feed/group-detail-view';
import { type GroupType } from '@/components/feed/grouped-items-card';
import { AsyncGroupedItemsCard } from '@/components/feed/grouped-items-card-async';
import { NotificationCard } from '@/components/feed/notification-card';
import { PostDetailView } from '@/components/feed/post-detail-view';
import { type CodeFixProgress, SuggestionCard } from '@/components/feed/suggestion-card';
import { SuggestionStatusLane } from '@/components/feed/suggestion-status-lane';
import { ThreadGroup } from '@/components/feed/thread-group';
import { PreferencesPanel } from '@/components/preferences-panel';
import { PwaInstallBanner } from '@/components/pwa/PwaInstallBanner';
import { SetupBanner } from '@/components/setup-banner';
import { type AgentTranscriptData, type AgentTranscriptState, type AgentTranscriptTarget, type BrainTranscriptEvent, type CurationTaskState, getAgentEventMetadata, resolveTaskTranscriptTarget, type TaskTranscriptFallbackState } from '@/lib/agent-transcript';
import { buildAnalysisRenderableEntries } from '@/lib/analysis-presentation';
import { AUTH_REQUIRED_MESSAGE, isAuthFailure } from '@/lib/auth-failure';
import { parseAutomaticCurationEnabled, parseBackgroundSourceBrowsingEnabled, updateAutomaticCurationConfigContent, updateBackgroundSourceBrowsingConfigContent } from '@/lib/automatic-curation-config';
import { type BrainProviderAvailabilityState, type BrainProviderName, type BrainProviderStateResponse, canOpenChatSessionCompactPopover, type ClaudeReasoningEffort, type CodexReasoningEffort, type CurateCommand, formatCompactTokenCount, getChatSessionCompactButtonState, getChatSessionContextHeaderMetrics, getChatSessionHeaderProviderLabel, getChatSessionManualCompactionUnavailableReason, getProviderChipLabel, getProviderDisplayName, resolveBrainState } from '@/lib/brain-provider';
import { CHAT_ATTACHMENT_ACCEPT } from '@/lib/chat-attachment-metadata';
import { getChatComposerTransferFiles, isChatComposerFileTransfer, uploadChatAttachmentFiles } from '@/lib/chat-composer-attachments';
import { buildSlashCommandComposerText, CHAT_COMPOSER_FORM_TEXT_ENTRY_ATTRIBUTES, CHAT_COMPOSER_TEXTBOX_TEXT_ENTRY_ATTRIBUTES, normalizeChatComposerText, normalizeFeedSearchQuery, shouldSubmitChatComposerKeyDown } from '@/lib/chat-composer-helpers';
import { doesChatTaskMatchConversation, getActiveChatTaskForConversation, getActiveChatTasks, getQueuedChatTasksForConversation } from '@/lib/chat-conversation-status';
import { renderChatMarkdown, renderHighlightedSearchText } from '@/lib/chat-markdown';
import { getChatMessageAttachments, getChatMessageAuthorLabel, getRenderableChatMessageText, mergeChatMessages, mergeComposerAttachments, shouldPersistChatProgress, updateChatMessageStatus } from '@/lib/chat-messages';
import { type ChatSessionCompactionState, type CompactFeedbackState, isChatSessionCompactionStateStale, type SessionCompactionPhase } from '@/lib/chat-session-compaction';
import { DEFAULT_GENERAL_AGENT_SESSION_TITLE, generateSessionTitle } from '@/lib/chat-session-title';
import { type ChatProgressState, doesLiveStateBelongToConversation, getFallbackChatProgress, getQueuedConversationDetail, getQueuedConversationLabel, getStreamingPreviewLine, hasDeliveredStreamingReply, type LiveActivitySnapshot, type LiveActivityStatus, shouldIgnoreSupersededLiveUpdate, type StreamingChatState } from '@/lib/chat-streaming-display';
import { type CodeFixReasoningEffort, parseCodeFixReasoningEffort, updateCodeFixReasoningEffortConfigContent } from '@/lib/code-fix-reasoning-config';
import { type SlashCommandSummary } from '@/lib/commands';
import { insertPlainTextIntoContentEditable, moveCaretToEnd, scheduleScrollToBottom, updateNearBottomRef } from '@/lib/composer-dom';
import { buildConversationPreviewText, buildSessionCards, type ConversationCardViewModel, conversationStatusLabel, mergeChatSessionSearchMatches, mergeConversationSessions, resolveChatSessionIdFromInReplyTo } from '@/lib/conversation-summary';
import { hasActiveCurationTask } from '@/lib/curation-status';
import { appendFeedFilterToFeedQuery, buildBaseFeedFilters, buildDynamicFeedSourceFilters, buildHeaderFeedFilters, type FeedFilter, type FeedFilterOption, type FeedSourceOption, getFeedFilterBadgeCount, hasTweetFeedSource, resolveFeedFilterClickAction } from '@/lib/feed-filters';
import { buildSuggestionGroupItems, getSuggestionGroupTitle as buildSuggestionGroupTitle, getSuggestionGroupLatestTimestamp, getSuggestionGroupPreviewItems, getSuggestionGroupStatus, isCurrentSuggestionStatus } from '@/lib/feed-groups';
import { compareFeedItems, countPrimaryFeedItems, createEmptyPendingCounts, getOldestLoadedPrimaryFeedItemTimestamp, getThreadGroupIdentity, getThreadGroupProminence, normalizeFeedItems, normalizePendingCounts, readTrimmedMetadataString, shouldIncludeConversationTimelineEntry, shouldRenderFeedEmptyState } from '@/lib/feed-normalize';
import { getNotificationGroupTitle, isActiveNotification, isDismissedNotification, isExpiredNotification } from '@/lib/feed-notifications';
import { compareTimelineEntries, type FeedRenderEntry, type ThreadGroupRenderEntry } from '@/lib/feed-render-entries';
import { buildSuggestionApplyRequest, getFeedSuggestionDefaultTitle, getSuggestionApplySuccessMessage, getSuggestionStatusLabel, isCodeFixSuggestion, readSuggestionActionErrorMessage, type SuggestionApplyResponse, wasSuggestionApplySuccessful } from '@/lib/feed-suggestions';
import { getThreadFeedbackProbe, getThreadSourceItemIds } from '@/lib/feedback-probe';
import { buildInlineCodeFixChatMessage, getInlineCodeFixSuggestion, type InlineCodeFixChatSuggestion } from '@/lib/inline-code-fix-messages';
import { type OrchestratorStatusResponse, type OrchestratorTaskStatus } from '@/lib/orchestrator';
import { useOverlayDismiss } from '@/lib/overlay-dismiss';
import { ACTIVE_CHAT_STATUS_SYNC_INTERVAL_MS, APP_HEADER_HEIGHT_FALLBACK_PX, CHAT_ACTIVITY_STALE_TIMEOUT_MS, CHAT_COMPOSER_GAP_PX, CHAT_COMPOSER_MIN_RESERVED_HEIGHT_PX, CHAT_HISTORY_PAGE_SIZE, CHAT_HISTORY_TOP_LOAD_THRESHOLD_PX, CHAT_INPUT_MAX_HEIGHT_PX, CHAT_SESSION_COMPACTION_STALE_TIMEOUT_MS, COMPACT_FEEDBACK_TIMEOUT_MS, CONVERSATION_SESSION_PAGE_SIZE, CURATION_FEED_POLL_INTERVAL_MS, CURATION_STATUS_POLL_INTERVAL_MS, DEFAULT_FEED_SORT_ORDER, FEED_BANNER_COMPLETED_TASK_TIMEOUT_MS, MAX_RESET_FEED_BATCHES, MIN_PRIMARY_FEED_ITEMS, PAGE_SIZE, POST_CONTEXT_SEPARATOR, RESTART_APPLY_POLL_INTERVAL_MS, RESTART_APPLY_WAIT_TIMEOUT_MS, RESTART_STATUS_POLL_INTERVAL_MS, SELECTED_CHAT_SESSION_AUTOCORRECT_GRACE_MS, SELECTED_CHAT_SESSION_STORAGE_KEY, STATUS_SYNC_INTERVAL_MS, SUGGESTION_PAGE_SIZE } from '@/lib/page-constants';
import { CLAUDE_REASONING_OPTIONS, CODEX_REASONING_OPTIONS, deriveCodexReasoningEffortFromConfig, formatClaudeReasoningEffortLabel, formatCodexReasoningEffortLabel } from '@/lib/reasoning-effort';
import { createReconnectingWs } from '@/lib/reconnecting-ws';
import { type RestartLifecycleState, type RestartLifecycleStatus } from '@/lib/restart-lifecycle';
import { textMatchesSearchQuery } from '@/lib/search-utils';
import { CURATOR_CURATE_HEADER_FULL_LABEL_MIN_ROW_WIDTH, getSessionTint, SESSION_TINT_PALETTE } from '@/lib/session-tints';
import { resolveSetupWizardSessionId, resolveSourceHealthSessionId, SETUP_WIZARD_COMMAND, SETUP_WIZARD_ORIGIN_VIEW, SOURCE_HEALTH_ORIGIN_VIEW, SOURCE_HEALTH_TRIGGER_SOURCE, SOURCE_STATUS_COMMAND } from '@/lib/setup-chat-routing';
import { type ActivityEvent, type SetupReadinessResponse, type SkillsApiResponse } from '@/lib/setup-types';
import { type SuggestionCreatorSessionTitles } from '@/lib/suggestion-creator-label';
import { applySuggestionChatFallbackReason, getGroupedCodeFixSuggestionChatContext, getSuggestionChatContext, resolveSuggestionChatDestination } from '@/lib/suggestion-routing';
import { partitionSuggestionItemsByLifecycle, type SuggestionLifecycleLane } from '@/lib/suggestion-status-lanes';
import { shouldSuppressFeedSystemNotice } from '@/lib/system-notices';
import { formatAbsoluteTimestamp, formatChatTimestamp, formatRelativeTimestamp } from '@/lib/timestamps';
import { formatWorkingDirectoryLabel } from '@/lib/working-directory';
import { type ChatAttachment, type ChatMessage, type ConfigSuggestionDecision } from '@/types/chat';
import { type ConversationSessionSummary, type ConversationSessionType } from '@/types/conversation';
import { type ChatSessionSearchMatch, type FeedbackProbeMetadata, type FeedItem, type FeedListResponse, type FeedPendingCounts, type FeedSuggestionGroup, type SuggestionStatus } from '@/types/feed';
import { type ChangeEvent, Fragment, type DragEvent as ReactDragEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

type DetailViewEntry =
  | {
    key: string;
    kind: 'post';
    routeId: string;
  }
  | {
    key: string;
    kind: 'chat';
    conversationId: string | null;
    contextPostId: string | null;
  }
  | {
    key: string;
    kind: 'group';
    groupId: string;
    groupType: GroupType;
    title: string;
    items: FeedItem[];
  };

// Chat session cards sit on a #050505 surface; keep the tint visible after compositing.

function resolveChatFetchErrorMessage(response: Response | null, error: unknown, fallback: string): string {
  return isAuthFailure(response, error) ? AUTH_REQUIRED_MESSAGE : error instanceof Error ? error.message : fallback;
}

interface OrchestratorCancelResponse {
  ok: boolean;
  error?: string;
  dequeued?: boolean;
  taskId?: string;
  chatMessageId?: string | null;
  sessionId?: string | null;
}

async function cancelOrchestratorTaskFromClient(taskId?: string | null): Promise<OrchestratorCancelResponse> {
  let response: Response | null = null;
  try {
    response = await fetch('/api/orchestrator/cancel', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
      body: JSON.stringify(taskId ? { taskId } : {}),
    });

    const text = await response.text();
    const result = text
      ? JSON.parse(text) as OrchestratorCancelResponse
      : { ok: response.ok };
    if (!response.ok && isAuthFailure(response, null)) {
      return { ...result, ok: false, error: AUTH_REQUIRED_MESSAGE };
    }
    return result;
  } catch (error) {
    if (isAuthFailure(response, error)) {
      return { ok: false, error: AUTH_REQUIRED_MESSAGE };
    }
    throw error;
  }
}

function createWsUrl(pathname: '/ws/feed' | '/ws/chat' | '/ws/orchestrator' | '/ws/agent-progress') {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${pathname}`;
}

function AgentUnavailableBanner({
  providerDisplayName,
  providerBinary,
}: {
  providerDisplayName: string;
  providerBinary: string;
}) {
  return (
    <div
      data-testid="agent-unavailable-banner"
      className="rounded-lg border border-red-500/40 bg-red-950 px-4 py-3 text-sm text-red-200"
    >
      <p className="font-medium text-red-300">Agent unavailable</p>
      <p className="mt-0.5 text-red-200/80">
        {providerDisplayName} not found. Chat and curation will not work. Ensure <code className="rounded bg-red-900/50 px-1 py-0.5 text-xs">{providerBinary}</code> is installed and in your PATH.
      </p>
    </div>
  );
}



















function ConversationCard({
  conversation,
  agentName,
  highlight,
  sessionTint,
  streamingChat,
  retainedLiveActivity,
  chatProgress,
  isCurateDisabled,
  isSendingChat,
  searchQuery,
  submitCurateToSession,
  onOpen,
}: {
  conversation: ConversationCardViewModel;
  agentName: string;
  highlight: boolean;
  sessionTint: typeof SESSION_TINT_PALETTE[number];
  streamingChat: StreamingChatState | null;
  retainedLiveActivity: LiveActivitySnapshot | null;
  chatProgress: ChatProgressState | null;
  isCurateDisabled: boolean;
  isSendingChat: boolean;
  searchQuery: string | null;
  submitCurateToSession: (
    sessionId: string,
    command: CurateCommand,
    options?: { openDetailOnSuccess?: boolean },
  ) => Promise<boolean>;
  onOpen: () => void;
}) {
  const liveStreamingPreview = streamingChat && doesLiveStateBelongToConversation(conversation, streamingChat)
    ? getStreamingPreviewLine(streamingChat.text)
    : '';
  const liveToolStatus = chatProgress
    && doesLiveStateBelongToConversation(conversation, chatProgress)
    && shouldPersistChatProgress(chatProgress.tool, chatProgress.activity)
      ? chatProgress
      : null;
  const queuedWhileRunningDetail = conversation.status === 'running' && conversation.queuedTaskCount > 0
    ? `${conversation.queuedTaskCount} more message${conversation.queuedTaskCount === 1 ? '' : 's'} queued in this conversation`
    : null;
  const queuedConversationLabel = conversation.status === 'queued'
    ? getQueuedConversationLabel(conversation)
    : null;
  const queuedConversationDetail = conversation.status === 'queued'
    ? getQueuedConversationDetail(conversation)
    : null;
  const shouldShowLiveActivity = Boolean(
    liveStreamingPreview
    || liveToolStatus
    || conversation.status === 'queued'
    || conversation.status === 'running',
  );
  const liveActivityBadge = conversation.status === 'queued'
    ? 'Queue'
    : liveToolStatus?.tool ?? (liveStreamingPreview ? 'Live' : 'Agent');
  const liveActivityLabel = queuedConversationLabel
    ?? (liveStreamingPreview
      ? 'Streaming reply'
      : liveToolStatus
        ? 'Tool activity'
        : 'Agent working');
  const liveActivityText = liveStreamingPreview
    || [
      liveToolStatus?.activity ?? (conversation.status === 'running' ? 'Working...' : null),
      queuedConversationDetail ?? queuedWhileRunningDetail,
    ].filter(Boolean).join(' • ')
    || 'Working...';
  const liveActivitySnapshot = useMemo<LiveActivitySnapshot | null>(() => (
    shouldShowLiveActivity
      ? {
        label: liveActivityLabel,
        detail: liveActivityText,
        badge: liveActivityBadge,
        status: conversation.status === 'queued' ? 'queued' : 'running',
      }
      : null
  ), [conversation.status, liveActivityBadge, liveActivityLabel, liveActivityText, shouldShowLiveActivity]);
  const displayedLiveActivity = liveActivitySnapshot ?? retainedLiveActivity;
  const isRetainedLiveActivity = !liveActivitySnapshot && retainedLiveActivity !== null;
  const liveActivityIconClass = displayedLiveActivity?.status === 'queued'
    ? 'text-sky-300'
    : displayedLiveActivity?.status === 'stalled'
      ? 'text-amber-300'
      : 'text-emerald-300';

  return (
    <div
      className={`overflow-hidden rounded-2xl border shadow-[0_0_0_1px_rgba(255,255,255,0.02)] transition-all ${
        highlight ? 'border-sky-500/70 ring-2 ring-sky-500/20' : ''
      }`}
      style={{
        backgroundColor: sessionTint.bg,
        ...(highlight ? {} : { borderColor: sessionTint.border }),
      }}
      data-testid={`conversation-card-${conversation.sessionId}`}
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-start gap-3 px-4 py-4 text-left transition hover:bg-white/[0.02]"
      >
        <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border" style={{ borderColor: sessionTint.iconBorder, backgroundColor: sessionTint.icon, color: sessionTint.text }}>
          <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4.5 w-4.5">
            <path
              d="M5 7.5A2.5 2.5 0 0 1 7.5 5h9A2.5 2.5 0 0 1 19 7.5v6A2.5 2.5 0 0 1 16.5 16H11l-4 3v-3.1A2.5 2.5 0 0 1 5 13.5v-6Z"
              className="fill-none stroke-current"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="1.8"
            />
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="min-w-0 flex-1 truncate text-sm font-semibold text-zinc-100">{conversation.title}</p>
            {conversation.sessionType === 'curator' ? (
              <CuratorCurateButtons
                disabled={isCurateDisabled || isSendingChat}
                tint={sessionTint}
                className="flex shrink-0 items-center gap-1.5 sm:gap-2"
                onContainerClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onSubmit={(command) => {
                  void submitCurateToSession(conversation.sessionId, command, { openDetailOnSuccess: false });
                }}
              />
            ) : (
              <span className="rounded-full border border-zinc-700 bg-black/30 px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] text-zinc-300">
                {conversationStatusLabel(conversation.status)}
              </span>
            )}
          </div>
          <div className="mt-2 space-y-1.5">
            {displayedLiveActivity ? (
              <div className={`rounded-xl border border-zinc-800/90 bg-black/20 px-2.5 py-2 ${isRetainedLiveActivity ? 'opacity-70' : ''}`}>
                <div className="flex min-h-11 items-start gap-2.5">
                  <span className={`mt-0.5 flex h-4.5 w-4.5 shrink-0 items-center justify-center ${liveActivityIconClass}`} aria-hidden="true">
                    {isRetainedLiveActivity ? (
                      <span className="h-2 w-2 rounded-full bg-current opacity-80" />
                    ) : displayedLiveActivity.status === 'queued' ? (
                      <span className="relative flex h-2 w-2">
                        <span
                          className="absolute inset-0 animate-ping rounded-full"
                          style={{ backgroundColor: 'currentColor', opacity: 0.35 }}
                        />
                        <span className="relative h-2 w-2 rounded-full bg-current" />
                      </span>
                    ) : (
                      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 animate-spin">
                        <circle cx="12" cy="12" r="9" className="fill-none stroke-current opacity-25" strokeWidth="2.5" />
                        <path d="M12 3a9 9 0 0 1 9 9" className="fill-none stroke-current" strokeLinecap="round" strokeWidth="2.5" />
                      </svg>
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full border border-zinc-700/80 bg-black/30 px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] text-zinc-200">
                        {displayedLiveActivity.badge}
                      </span>
                      <span className={`text-[11px] uppercase tracking-[0.16em] ${isRetainedLiveActivity ? 'text-zinc-500' : 'text-zinc-400'}`}>
                        {displayedLiveActivity.label}
                      </span>
                    </div>
                    <p
                      className={`mt-1 truncate text-sm leading-5 ${isRetainedLiveActivity ? 'text-zinc-300' : 'text-zinc-200'}`}
                    >
                      {displayedLiveActivity.detail}
                    </p>
                  </div>
                </div>
              </div>
            ) : null}

            {conversation.previewMessages.length > 0 ? (
              conversation.previewMessages.map((message) => (
                <div
                  key={message.id}
                  className="flex items-start gap-2 text-sm leading-5 text-zinc-300"
                >
                  <span className="shrink-0 text-[11px] font-medium uppercase tracking-[0.16em] text-zinc-500">
                    {getChatMessageAuthorLabel(message, agentName)}
                  </span>
                  <p className="min-w-0 flex-1 truncate">
                    {renderHighlightedSearchText(buildConversationPreviewText(message, searchQuery), searchQuery)}
                  </p>
                </div>
              ))
            ) : (
              <p className="text-sm leading-6 text-zinc-300">{conversation.summary}</p>
            )}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
            <span>{conversation.messageCount} message{conversation.messageCount === 1 ? '' : 's'}</span>
            <span>•</span>
            <span>
              {conversation.lastMessage
                ? getChatMessageAuthorLabel(conversation.lastMessage, agentName)
                : conversation.lastActor === 'user'
                  ? 'You'
                  : agentName}
            </span>
            <span>•</span>
            {conversation.provider && (
              <>
                <span>{getProviderChipLabel(conversation.provider)}</span>
                <span>•</span>
              </>
            )}
            <span>{formatRelativeTimestamp(conversation.lastTimestamp)}</span>
            {conversation.queuePosition !== null && conversation.queuePosition > 0 && (
              <>
                <span>•</span>
                <span>Queue #{conversation.queuePosition}</span>
              </>
            )}
          </div>
        </div>
      </button>
    </div>
  );
}

function ConversationDetail({
  conversation,
  agentName,
  curationTask,
  visibleStreamingChat,
  retainedLiveActivity,
  lastChatActivityAt,
  chatProgress,
  orchestratorStatus,
  onInlineCodeFixSuggestionDecision,
  resolveInlineCodeFixSuggestionStatus,
  suggestionPendingActions,
  suggestionFeedback,
  onCancelTask,
  shouldScrollToBottom,
  onDidScrollToBottom,
  scrollToMessageId,
  onDidScrollToMessage,
  emptyState,
  showCurationStatusWhenEmpty = false,
  detailEntryKey,
  layoutMode = 'feed',
  composerReservedHeight = 0,
  searchQuery = null,
}: {
  conversation: ConversationCardViewModel | null;
  agentName: string;
  curationTask: CurationTaskState | null;
  visibleStreamingChat: StreamingChatState | null;
  retainedLiveActivity: LiveActivitySnapshot | null;
  lastChatActivityAt: number | null;
  chatProgress: ChatProgressState | null;
  orchestratorStatus: OrchestratorStatusResponse | null;
  onInlineCodeFixSuggestionDecision: (
    suggestion: InlineCodeFixChatSuggestion,
    decision: ConfigSuggestionDecision,
  ) => void;
  resolveInlineCodeFixSuggestionStatus: (
    conversation: ConversationCardViewModel,
    suggestion: InlineCodeFixChatSuggestion,
  ) => SuggestionStatus;
  suggestionPendingActions: Record<string, 'accept' | 'dismiss' | null>;
  suggestionFeedback: Record<string, string>;
  onCancelTask: (taskId: string | null) => Promise<OrchestratorCancelResponse>;
  shouldScrollToBottom?: boolean;
  onDidScrollToBottom?: () => void;
  scrollToMessageId?: string | null;
  onDidScrollToMessage?: () => void;
  emptyState?: ReactNode;
  showCurationStatusWhenEmpty?: boolean;
  detailEntryKey?: string;
  layoutMode?: 'feed' | 'detail';
  composerReservedHeight?: number;
  searchQuery?: string | null;
}) {
  const isDetailLayout = layoutMode === 'detail';
  const liveToolStatus = conversation
    && chatProgress
    && shouldPersistChatProgress(chatProgress.tool, chatProgress.activity)
    && doesLiveStateBelongToConversation(conversation, chatProgress)
      ? chatProgress
      : null;
  const [isWorkingIndicatorStale, setIsWorkingIndicatorStale] = useState(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const runningSinceRef = useRef<number | null>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const messagesInnerRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const isPinnedToBottomRef = useRef(true);
  const [loadedOlderMessageCount, setLoadedOlderMessageCount] = useState(0);
  const initializedScrollConversationIdRef = useRef<string | null>(null);
  const lastConversationIdRef = useRef<string | null>(conversation?.sessionId ?? null);
  const lastDetailEntryKeyRef = useRef(detailEntryKey ?? null);
  const pendingScrollRestoreRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const latestSearchMatchMessageId = useMemo(() => {
    if (!conversation || !searchQuery) {
      return null;
    }

    return conversation.messages
      .filter((message) => message.type === 'chat')
      .filter((message) => textMatchesSearchQuery(getRenderableChatMessageText(message), searchQuery))
      .sort((left, right) => right.timestamp.localeCompare(left.timestamp))[0]?.id ?? null;
  }, [conversation, searchQuery]);
  const effectiveScrollToMessageId = scrollToMessageId ?? latestSearchMatchMessageId;
  const targetMessageIndex = conversation && effectiveScrollToMessageId
    ? conversation.messages.findIndex((message) => message.id === effectiveScrollToMessageId)
    : -1;
  const targetVisibleMessageCount = conversation && targetMessageIndex >= 0
    ? conversation.messages.length - targetMessageIndex
    : 0;
  const visibleMessageCount = Math.min(
    conversation?.messages.length ?? 0,
    Math.max(CHAT_HISTORY_PAGE_SIZE + loadedOlderMessageCount, targetVisibleMessageCount),
  );
  const visibleMessages = useMemo(() => (
    conversation
      ? conversation.messages.slice(Math.max(0, conversation.messages.length - visibleMessageCount))
      : []
  ), [conversation, visibleMessageCount]);
  const sessionTint = conversation
    ? getSessionTint(conversation.sessionId, conversation.color)
    : SESSION_TINT_PALETTE[0];
  const hasOlderMessages = conversation ? visibleMessageCount < conversation.messages.length : false;
  const conversationId = conversation?.sessionId ?? null;
  const streamingPreviewText = useMemo(() => {
    if (!conversation || !visibleStreamingChat?.text) {
      return '';
    }
    return doesLiveStateBelongToConversation(conversation, visibleStreamingChat)
      ? getStreamingPreviewLine(visibleStreamingChat.text)
      : '';
  }, [conversation, visibleStreamingChat]);
  const currentChatTask = orchestratorStatus?.currentTask ?? null;
  const queuedChatTasks = useMemo(() => (
    conversation
      ? getQueuedChatTasksForConversation(conversation.sessionId, conversation.messages, orchestratorStatus)
      : []
  ), [conversation, orchestratorStatus]);
  const queuedTaskByMessageId = useMemo(() => {
    const map = new Map<string, OrchestratorTaskStatus>();
    for (const task of queuedChatTasks) {
      const chatMessageId = typeof task.chatMessageId === 'string' ? task.chatMessageId.trim() : '';
      if (!chatMessageId) {
        continue;
      }
      map.set(chatMessageId, task);
    }
    return map;
  }, [queuedChatTasks]);
  const firstQueuedTask = queuedChatTasks[0] ?? null;
  const activeChatTaskId = conversation?.activeTaskId
    ?? (
      conversation
      && doesChatTaskMatchConversation(
        currentChatTask,
        conversation.sessionId,
        conversation.messages,
      )
        ? currentChatTask?.id ?? null
        : null
    )
    ?? conversation?.chatTaskId
    ?? null;
  const queuedWhileRunningDetail = conversation?.status === 'running' && (conversation.queuedTaskCount ?? 0) > 0
    ? `${conversation.queuedTaskCount} more message${conversation.queuedTaskCount === 1 ? '' : 's'} queued in this conversation`
    : null;
  const isConversationQueued = conversation?.status === 'queued';
  const shouldShowLiveActivity = Boolean(
    conversation
    && (
      isConversationQueued
      || conversation.status === 'running'
      || liveToolStatus
      || streamingPreviewText
    ),
  );
  const queuedConversationLabel = conversation && isConversationQueued
    ? getQueuedConversationLabel(conversation)
    : null;
  const queuedConversationDetail = conversation && isConversationQueued
    ? getQueuedConversationDetail(conversation)
    : null;
  const workingIndicatorLabel = queuedConversationLabel
    ?? (
      isWorkingIndicatorStale
        ? 'Agent is working...'
        : streamingPreviewText
          ? 'Streaming reply'
          : liveToolStatus
            ? 'Tool activity'
            : 'Agent working'
    );
  const workingIndicatorDetail = streamingPreviewText
    || [
      liveToolStatus?.activity
        ?? (isWorkingIndicatorStale ? 'This is taking longer than usual.' : 'Working...'),
      queuedConversationDetail ?? queuedWhileRunningDetail,
    ].filter(Boolean).join(' • ')
    || (isWorkingIndicatorStale ? 'This is taking longer than usual.' : 'Working...');
  const workingIndicatorBadge = isConversationQueued
    ? 'Queue'
    : liveToolStatus?.tool ?? (streamingPreviewText ? 'Live' : 'Agent');
  const workingIndicatorStatus: LiveActivityStatus = isConversationQueued
    ? 'queued'
    : 'running';
  const liveActivitySnapshot = useMemo<LiveActivitySnapshot | null>(() => (
    shouldShowLiveActivity
      ? {
        label: workingIndicatorLabel,
        detail: workingIndicatorDetail,
        badge: workingIndicatorBadge,
        status: workingIndicatorStatus,
      }
      : null
  ), [
    shouldShowLiveActivity,
    workingIndicatorBadge,
    workingIndicatorDetail,
    workingIndicatorLabel,
    workingIndicatorStatus,
  ]);
  const displayedLiveActivity = liveActivitySnapshot ?? retainedLiveActivity;
  const isRetainedLiveActivity = !liveActivitySnapshot && retainedLiveActivity !== null;
  const shouldTrackLiveStaleness = Boolean(
    conversation
    && (
      conversation.status === 'running'
      || liveToolStatus
      || streamingPreviewText
    ),
  );
  const shouldShowCurationStatusBanner = Boolean(
    curationTask
    && (conversation?.contextKind === 'global' || (!conversation && showCurationStatusWhenEmpty)),
  );
  const [pendingQueuedCancelTaskIds, setPendingQueuedCancelTaskIds] = useState<Record<string, boolean>>({});
  const syncNearBottomState = useCallback((isNearBottom: boolean) => {
    setShowScrollToBottom(!isNearBottom);
  }, []);
  const pinScrollToBottom = useCallback(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    container.scrollTop = container.scrollHeight;
    updateNearBottomRef(container, isNearBottomRef, syncNearBottomState);
  }, [syncNearBottomState]);
  const handleQueuedTaskCancel = useCallback(async (taskId: string | null) => {
    if (!taskId) {
      return;
    }

    setPendingQueuedCancelTaskIds((current) => ({ ...current, [taskId]: true }));
    try {
      await onCancelTask(taskId);
    } finally {
      setPendingQueuedCancelTaskIds((current) => {
        if (!current[taskId]) {
          return current;
        }
        const next = { ...current };
        delete next[taskId];
        return next;
      });
    }
  }, [onCancelTask]);
  const scrollToMessage = useCallback((messageId: string, behavior: ScrollBehavior = 'auto') => {
    const container = messagesContainerRef.current;
    if (!container) return false;

    const target = Array.from(container.querySelectorAll<HTMLElement>('[data-chat-message-id]'))
      .find((element) => element.dataset.chatMessageId === messageId);
    if (!target) return false;

    target.scrollIntoView({ block: 'center', behavior });
    updateNearBottomRef(container, isNearBottomRef, syncNearBottomState);
    return true;
  }, [syncNearBottomState]);

  useLayoutEffect(() => {
    const pendingRestore = pendingScrollRestoreRef.current;
    const container = messagesContainerRef.current;
    if (!pendingRestore || !container) return;

    const heightDelta = container.scrollHeight - pendingRestore.scrollHeight;
    container.scrollTop = pendingRestore.scrollTop + heightDelta;
    pendingScrollRestoreRef.current = null;
    updateNearBottomRef(container, isNearBottomRef, syncNearBottomState);
  }, [syncNearBottomState, visibleMessageCount]);

  useLayoutEffect(() => {
    if (lastDetailEntryKeyRef.current === detailEntryKey) return;

    lastDetailEntryKeyRef.current = detailEntryKey ?? null;
    initializedScrollConversationIdRef.current = null;
    isPinnedToBottomRef.current = true;
  }, [detailEntryKey]);

  useLayoutEffect(() => {
    return () => {
      initializedScrollConversationIdRef.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    if (lastConversationIdRef.current !== conversationId) {
      lastConversationIdRef.current = conversationId;
      initializedScrollConversationIdRef.current = null;
      isPinnedToBottomRef.current = true;
    }

    if (!conversationId) return;
    if (initializedScrollConversationIdRef.current === conversationId) return;
    if (visibleMessages.length === 0 && !streamingPreviewText && !shouldShowLiveActivity) return;

    if (effectiveScrollToMessageId) {
      if (!visibleMessages.some((message) => message.id === effectiveScrollToMessageId)) {
        return;
      }

      initializedScrollConversationIdRef.current = conversationId;
      isPinnedToBottomRef.current = false;
      const frameId = window.requestAnimationFrame(() => {
        if (scrollToMessage(effectiveScrollToMessageId, 'auto') && scrollToMessageId) {
          onDidScrollToMessage?.();
        }
      });

      return () => {
        window.cancelAnimationFrame(frameId);
      };
    }

    initializedScrollConversationIdRef.current = conversationId;
    isPinnedToBottomRef.current = true;
    scheduleScrollToBottom(messagesContainerRef, isNearBottomRef, 'auto', 0, syncNearBottomState);
  }, [
    conversationId,
    effectiveScrollToMessageId,
    onDidScrollToMessage,
    scrollToMessage,
    scrollToMessageId,
    shouldShowLiveActivity,
    streamingPreviewText,
    syncNearBottomState,
    visibleMessages,
  ]);

  useEffect(() => {
    if (effectiveScrollToMessageId) {
      isPinnedToBottomRef.current = false;
      return;
    }

    const container = messagesContainerRef.current;
    updateNearBottomRef(container, isNearBottomRef, syncNearBottomState);
    if (container && isNearBottomRef.current) {
      isPinnedToBottomRef.current = true;
    }
  }, [effectiveScrollToMessageId, syncNearBottomState]);

  useEffect(() => {
    if (effectiveScrollToMessageId) return;
    if (!conversationId) return;
    const inner = messagesInnerRef.current;
    const container = messagesContainerRef.current;
    if (!inner || !container || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(() => {
      if (!isPinnedToBottomRef.current) return;

      pinScrollToBottom();
    });

    observer.observe(inner);
    return () => {
      observer.disconnect();
    };
  }, [conversationId, effectiveScrollToMessageId, pinScrollToBottom]);

  useEffect(() => {
    const container = messagesContainerRef.current;
    updateNearBottomRef(container, isNearBottomRef, syncNearBottomState);
    if (!container) return;

    const loadOlderMessages = () => {
      if (!hasOlderMessages || pendingScrollRestoreRef.current) return;

      pendingScrollRestoreRef.current = {
        scrollHeight: container.scrollHeight,
        scrollTop: container.scrollTop,
      };
      setLoadedOlderMessageCount((current) => current + CHAT_HISTORY_PAGE_SIZE);
    };

    const handleScroll = () => {
      updateNearBottomRef(container, isNearBottomRef, syncNearBottomState);
      isPinnedToBottomRef.current = effectiveScrollToMessageId ? false : isNearBottomRef.current;
      if (container.scrollTop <= CHAT_HISTORY_TOP_LOAD_THRESHOLD_PX) {
        loadOlderMessages();
      }
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', handleScroll);
    };
  }, [effectiveScrollToMessageId, hasOlderMessages, syncNearBottomState]);

  useEffect(() => {
    if (!shouldTrackLiveStaleness) {
      runningSinceRef.current = null;
      const frameId = window.requestAnimationFrame(() => {
        setIsWorkingIndicatorStale(false);
      });

      return () => {
        window.cancelAnimationFrame(frameId);
      };
    }

    const now = Date.now();
    if (runningSinceRef.current === null) {
      runningSinceRef.current = now;
    }

    const lastActivity = lastChatActivityAt ?? runningSinceRef.current;
    const remainingMs = CHAT_ACTIVITY_STALE_TIMEOUT_MS - (now - lastActivity);
    const resetFrameId = window.requestAnimationFrame(() => {
      setIsWorkingIndicatorStale(false);
    });

    if (remainingMs <= 0) {
      const timeoutId = window.setTimeout(() => {
        setIsWorkingIndicatorStale(true);
      }, 0);

      return () => {
        window.cancelAnimationFrame(resetFrameId);
        window.clearTimeout(timeoutId);
      };
    }

    const timeoutId = window.setTimeout(() => {
      setIsWorkingIndicatorStale(true);
    }, remainingMs);

    return () => {
      window.cancelAnimationFrame(resetFrameId);
      window.clearTimeout(timeoutId);
    };
  }, [lastChatActivityAt, shouldTrackLiveStaleness]);

  useEffect(() => {
    if (shouldScrollToBottom && conversationId && !effectiveScrollToMessageId) {
      isPinnedToBottomRef.current = true;
      scheduleScrollToBottom(messagesContainerRef, isNearBottomRef, 'smooth', 1, syncNearBottomState);
      onDidScrollToBottom?.();
    }
  }, [conversationId, effectiveScrollToMessageId, onDidScrollToBottom, shouldScrollToBottom, syncNearBottomState]);

  if (!conversation) {
    return (
      <div className="space-y-3">
        {shouldShowCurationStatusBanner && curationTask ? (
          <ChatCurationStatusBanner task={curationTask} />
        ) : null}
        <div data-testid="conversation-detail-empty" className="rounded-2xl border border-zinc-800 bg-zinc-950/80 px-4 py-6 text-sm text-zinc-400">
          {emptyState ?? 'Conversation unavailable.'}
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid={`conversation-detail-${conversation.sessionId}`}
      className={isDetailLayout ? 'relative flex min-h-0 flex-1 flex-col gap-4' : 'relative space-y-4'}
    >
      <div
        ref={messagesContainerRef}
        data-testid="chat-overlay-scroll"
        data-search-detail-root=""
        data-chat-messages=""
        data-total-message-count={conversation.messages.length}
        data-visible-message-count={visibleMessages.length}
        className={isDetailLayout
          ? 'min-h-0 flex-1 overflow-y-auto rounded-2xl border border-zinc-900 bg-[#050505] shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]'
          : 'max-h-[65vh] min-h-[24rem] overflow-y-auto rounded-2xl border border-zinc-900 bg-[#050505] shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]'}
      >
        <div
          ref={messagesInnerRef}
          className="space-y-2 px-3 py-3"
          style={composerReservedHeight > 0 ? { paddingBottom: `${composerReservedHeight}px` } : undefined}
        >
          {shouldShowCurationStatusBanner && curationTask ? (
            <ChatCurationStatusBanner task={curationTask} />
          ) : null}
          {visibleMessages.map((message) => {
            const attachments = getChatMessageAttachments(message);

            if (message.type === 'agent_event') {
              const inlineCodeFixSuggestion = getInlineCodeFixSuggestion(message);
              if (inlineCodeFixSuggestion && conversation) {
                const currentStatus = resolveInlineCodeFixSuggestionStatus(conversation, inlineCodeFixSuggestion);
                const pendingAction = suggestionPendingActions[inlineCodeFixSuggestion.id];
                const feedback = suggestionFeedback[inlineCodeFixSuggestion.id];
                const isPending = pendingAction === 'accept' || pendingAction === 'dismiss';
                const isActionable = currentStatus === 'pending';

                return (
                  <div key={message.id} data-chat-entry="" data-chat-message-id={message.id} className="flex justify-start">
                    <div className="min-w-0 max-w-[88%] rounded-2xl border border-amber-800/60 bg-amber-950/20 px-3 py-2.5 text-zinc-100">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-xs font-medium uppercase tracking-wide text-amber-200">Code fix suggestion</p>
                          <p className="mt-1 text-sm font-semibold text-zinc-50">{inlineCodeFixSuggestion.title}</p>
                          <p className="mt-1 text-sm leading-5 text-zinc-200">{inlineCodeFixSuggestion.summary}</p>
                        </div>
                        <span className="shrink-0 text-[11px] text-zinc-500">{formatChatTimestamp(message.timestamp)}</span>
                      </div>
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        {isActionable ? (
                          <>
                            <button
                              type="button"
                              disabled={isPending}
                              onClick={() => onInlineCodeFixSuggestionDecision(inlineCodeFixSuggestion, 'accepted')}
                              className="inline-flex items-center gap-1.5 rounded border border-emerald-700 px-2.5 py-1 text-[11px] text-emerald-200 hover:bg-emerald-900/40 disabled:opacity-60"
                            >
                              {pendingAction === 'accept' ? 'Approving Fix...' : 'Approve Fix'}
                            </button>
                            <button
                              type="button"
                              disabled={isPending}
                              onClick={() => onInlineCodeFixSuggestionDecision(inlineCodeFixSuggestion, 'rejected')}
                              className="rounded border border-zinc-700 px-2.5 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-60"
                            >
                              {pendingAction === 'dismiss' ? 'Dismissing...' : 'Dismiss'}
                            </button>
                          </>
                        ) : (
                          <span className="inline-flex items-center rounded border border-zinc-700 bg-black/30 px-2.5 py-1 text-[11px] text-zinc-200">
                            {getSuggestionStatusLabel(currentStatus)}
                          </span>
                        )}
                      </div>
                      {feedback ? (
                        <p className="mt-2 text-[11px] text-amber-200">{feedback}</p>
                      ) : null}
                    </div>
                  </div>
                );
              }

              return (
                <div key={message.id} data-chat-entry="" data-chat-message-id={message.id} className="rounded-2xl border border-zinc-800 bg-black/30 px-3 py-2 text-xs text-zinc-300">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium uppercase tracking-wide text-zinc-400">Agent event</span>
                    <span className="text-zinc-500">{formatChatTimestamp(message.timestamp)}</span>
                  </div>
                  <p className="mt-1 leading-5">{message.text}</p>
                </div>
              );
            }

            return (
              <div key={message.id} data-chat-entry="" data-chat-message-id={message.id} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                {(() => {
                  const queuedTask = queuedTaskByMessageId.get(message.id) ?? null;
                  const queuedTaskId = queuedTask?.id ?? null;
                  const isQueuedUserMessage = message.role === 'user' && Boolean(queuedTaskId);
                  const isQueuedCancelPending = queuedTaskId ? Boolean(pendingQueuedCancelTaskIds[queuedTaskId]) : false;
                  const isCancelledMessage = message.status === 'cancelled';
                  const authorLabel = getChatMessageAuthorLabel(message, agentName, { isCancelled: isCancelledMessage });

                  return (
                <div
                  className={`min-w-0 max-w-[88%] rounded-2xl border px-3 py-2 ${
                  message.role === 'user'
                    ? `text-zinc-100 ${isCancelledMessage ? 'opacity-60' : ''}`
                    : 'border border-zinc-800 bg-zinc-900 text-zinc-100'
                  }`}
                  style={message.role === 'user'
                    ? { backgroundColor: sessionTint.bg, borderColor: sessionTint.border }
                    : undefined}
                >
                  {attachments.length > 0 && (
                    <div className="mb-2 flex flex-wrap gap-2">
                      {attachments.map((attachment) => (
                        <ChatAttachmentCard
                          key={attachment.filePath}
                          attachment={attachment}
                          compact
                        />
                      ))}
                    </div>
                  )}
                  <div className="flex items-start gap-2">
                    <div className={`min-w-0 flex-1 text-base leading-relaxed ${isCancelledMessage ? 'line-through decoration-zinc-500/70' : ''}`}>
                      {renderChatMarkdown(message.text, searchQuery)}
                    </div>
                    {isQueuedUserMessage ? (
                      <ChatStopButton
                        onClick={() => { void handleQueuedTaskCancel(queuedTaskId); }}
                        variant="dismiss"
                        title="Cancel queued message"
                        ariaLabel="Cancel queued message"
                        disabled={isQueuedCancelPending}
                      />
                    ) : null}
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-zinc-500">
                    <span>{authorLabel}</span>
                    <span>{formatChatTimestamp(message.timestamp)}</span>
                  </div>

                </div>
                  );
                })()}
              </div>
            );
          })}

          {displayedLiveActivity && (
            <ChatWorkingIndicator
              label={displayedLiveActivity.label}
              detail={displayedLiveActivity.detail}
              badge={displayedLiveActivity.badge}
              status={displayedLiveActivity.status}
              onStop={!isRetainedLiveActivity && activeChatTaskId ? () => { void onCancelTask(activeChatTaskId); } : null}
              onCancelQueued={
                !isRetainedLiveActivity
                && conversation.status === 'running'
                && firstQueuedTask
                && !pendingQueuedCancelTaskIds[firstQueuedTask.id]
                  ? () => { void handleQueuedTaskCancel(firstQueuedTask.id); }
                  : null
              }
              muted={isRetainedLiveActivity}
            />
          )}
        </div>
      </div>
      {showScrollToBottom && (
        <button
          type="button"
          aria-label="Scroll to bottom"
          onClick={() => {
            isPinnedToBottomRef.current = true;
            scheduleScrollToBottom(messagesContainerRef, isNearBottomRef, 'smooth', 1, syncNearBottomState);
          }}
          className="absolute left-1/2 z-10 inline-flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full border border-zinc-700 bg-zinc-800/90 text-zinc-100 shadow-lg shadow-black/40 transition hover:bg-zinc-700/95"
          style={{ bottom: `${composerReservedHeight > 0 ? composerReservedHeight + 8 : 8}px` }}
        >
          <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4">
            <path
              d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 11.168l3.71-3.938a.75.75 0 1 1 1.08 1.04l-4.25 4.5a.75.75 0 0 1-1.08 0l-4.25-4.5a.75.75 0 0 1 .02-1.06z"
              fill="currentColor"
            />
          </svg>
        </button>
      )}
    </div>
  );
}

function FeedFilterButton({
  filter,
  selected,
  badgeCount,
  onClick,
}: {
  filter: FeedFilterOption;
  selected: boolean;
  badgeCount?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={filter.testId}
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-1.5 text-[10px] font-medium tracking-tight transition-colors sm:gap-1.5 sm:px-3 sm:text-[11px] ${
        selected
          ? 'border-sky-400/50 bg-sky-500/20 text-sky-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]'
          : 'border-transparent bg-zinc-900/70 text-zinc-400 hover:border-zinc-700/80 hover:bg-zinc-800/80 hover:text-zinc-200'
      }`}
      aria-pressed={selected}
    >
      <span>{filter.label}</span>
      {badgeCount && badgeCount > 0 ? (
        <span className={`inline-flex min-w-[1.125rem] shrink-0 items-center justify-center rounded-full px-1 py-0.5 text-[9px] font-semibold leading-none sm:min-w-5 sm:px-1.5 sm:text-[10px] ${
          selected ? 'bg-amber-300 text-amber-950' : 'bg-amber-500/90 text-zinc-950'
        }`}>
          {badgeCount > 99 ? '99+' : badgeCount}
        </span>
      ) : null}
    </button>
  );
}

function RenameSessionModal({
  open,
  title,
  error,
  isSubmitting,
  onClose,
  onSubmit,
  onTitleChange,
}: {
  open: boolean;
  title: string;
  error: string | null;
  isSubmitting: boolean;
  onClose: () => void;
  onSubmit: () => void;
  onTitleChange: (value: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const { backdropProps } = useOverlayDismiss({
    enabled: open,
    onClose,
    closeOnBackdropPress: !isSubmitting,
    closeOnEscape: !isSubmitting,
  });

  useEffect(() => {
    if (!open) return;

    const focusTimer = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);

    return () => {
      window.clearTimeout(focusTimer);
    };
  }, [open]);

  if (!open) {
    return null;
  }

  const isSaveDisabled = isSubmitting || !title.trim();

  return (
    <div className="pointer-events-auto fixed inset-0 z-[95] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="rename-session-modal-title">
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-black/70"
        {...backdropProps}
      />
      <form
        className="relative z-[96] w-full max-w-md rounded-[1.75rem] border border-zinc-800 bg-zinc-950 p-5 shadow-2xl"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div className="space-y-2">
          <h2 id="rename-session-modal-title" className="text-xl font-semibold text-zinc-50">Rename session</h2>
        </div>
        <label className="mt-5 block">
          <span className="mb-2 block text-sm font-medium text-zinc-200">Session name</span>
          <input
            ref={inputRef}
            type="text"
            value={title}
            onChange={(event) => onTitleChange(event.target.value)}
            placeholder="Session title"
            disabled={isSubmitting}
            className="w-full rounded-2xl border border-zinc-700 bg-zinc-900 px-4 py-3 text-sm text-zinc-100 outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-400/20 disabled:cursor-not-allowed disabled:opacity-60"
          />
        </label>
        {error && (
          <p className="mt-3 rounded-2xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
            {error}
          </p>
        )}
        <div className="mt-5 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="rounded-full border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isSaveDisabled}
            className="rounded-full bg-sky-400 px-4 py-2 text-sm font-semibold text-zinc-950 transition hover:bg-sky-300 disabled:cursor-not-allowed disabled:bg-sky-400/60"
          >
            {isSubmitting ? 'Saving...' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}






export default function Home() {
  const [items, setItems] = useState<FeedItem[]>([]);
  const [suggestionGroup, setSuggestionGroup] = useState<FeedSuggestionGroup | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [selectedFilter, setSelectedFilter] = useState<FeedFilter>('all');
  const sortOrder = DEFAULT_FEED_SORT_ORDER;
  const [searchDraft, setSearchDraft] = useState('');
  const [searchQuery, setSearchQuery] = useState<string | null>(null);
  const [hasLoadedSearchQuery, setHasLoadedSearchQuery] = useState(false);
  const [suggestionStatusOverrides, setSuggestionStatusOverrides] = useState<Record<string, SuggestionStatus>>({});
  const [codeFixProgressMap, setCodeFixProgressMap] = useState<Record<string, CodeFixProgress>>({});
  const [groupDetailEntry, setGroupDetailEntry] = useState<{ groupId: string; groupType: GroupType; title: string; items: FeedItem[] } | null>(null);
  const [suggestionPendingActions, setSuggestionPendingActions] = useState<Record<string, 'accept' | 'dismiss' | null>>({});
  const [suggestionFeedback, setSuggestionFeedback] = useState<Record<string, string>>({});
  const [notificationPendingActions, setNotificationPendingActions] = useState<Record<string, 'dismiss' | null>>({});
  const [notificationFeedback, setNotificationFeedback] = useState<Record<string, string>>({});
  const [pendingCounts, setPendingCounts] = useState<FeedPendingCounts>(createEmptyPendingCounts());
  const [skillsFeedSources, setSkillsFeedSources] = useState<FeedSourceOption[]>([]);
  const [showConfigEditor, setShowConfigEditor] = useState(false);
  const [showPreferencesPanel, setShowPreferencesPanel] = useState(false);
  const [isBrainProviderModalOpen, setIsBrainProviderModalOpen] = useState(false);
  const [isUsageModalOpen, setIsUsageModalOpen] = useState(false);
  const [isCodeFixReasoningModalOpen, setIsCodeFixReasoningModalOpen] = useState(false);
  const usageSummaryLabels = useUsageSummaryLabels(isUsageModalOpen);
  const [activity, setActivity] = useState<{ sessionExists: boolean; working: boolean }>({ sessionExists: false, working: false });
  const [, setTick] = useState(0);
  const [orchestratorStatus, setOrchestratorStatus] = useState<OrchestratorStatusResponse | null>(null);
  const [pendingItems, setPendingItems] = useState<FeedItem[]>([]);

  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [conversationSessions, setConversationSessions] = useState<ConversationSessionSummary[]>([]);
  const [searchChatSessionMatches, setSearchChatSessionMatches] = useState<ChatSessionSearchMatch[]>([]);
  const [conversationSessionsHasMore, setConversationSessionsHasMore] = useState(false);
  const [isLoadingConversationSessions, setIsLoadingConversationSessions] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [restartState, setRestartState] = useState<RestartLifecycleState | null>(null);
  const [isApplyingRestart, setIsApplyingRestart] = useState(false);
  const [restartReloadPending, setRestartReloadPending] = useState(false);
  const [chatInput, setChatInput] = useState('');
  const [chatContext, setChatContext] = useState<string | null>(null);
  const [chatAttachments, setChatAttachments] = useState<ChatAttachment[]>([]);
  const [chatPostContext, setChatPostContext] = useState<FeedItem | null>(null);
  const [chatSelectedText, setChatSelectedText] = useState<string | null>(null);
  const [pendingChatAboutRequest, setPendingChatAboutRequest] = useState<{
    itemId: string;
    selectedText: string | null;
  } | null>(null);
  const [configContent, setConfigContent] = useState<string | null>(null);
  const [isSavingAutomaticCuration, setIsSavingAutomaticCuration] = useState(false);
  const [automaticCurationError, setAutomaticCurationError] = useState<string | null>(null);
  const [isSavingBackgroundSourceBrowsing, setIsSavingBackgroundSourceBrowsing] = useState(false);
  const [backgroundSourceBrowsingError, setBackgroundSourceBrowsingError] = useState<string | null>(null);
  const [isSavingCodeFixReasoning, setIsSavingCodeFixReasoning] = useState(false);
  const [codeFixReasoningError, setCodeFixReasoningError] = useState<string | null>(null);
  const [brainProviderStatus, setBrainProviderStatus] = useState<BrainProviderStateResponse | null>(null);
  const [brainProviderStatusError, setBrainProviderStatusError] = useState<string | null>(null);
  const [isLoadingBrainProviderStatus, setIsLoadingBrainProviderStatus] = useState(false);
  const [isSwitchingBrainProvider, setIsSwitchingBrainProvider] = useState(false);
  const [pendingBrainProvider, setPendingBrainProvider] = useState<BrainProviderName>('claude');
  const [pendingCodexReasoningEffort, setPendingCodexReasoningEffort] = useState<CodexReasoningEffort>('high');
  const [, setBrainTyping] = useState(false);
  const [streamingChat, setStreamingChat] = useState<StreamingChatState | null>(null);
  const [chatProgress, setChatProgress] = useState<ChatProgressState | null>(null);
  const [retainedLiveActivityBySession, setRetainedLiveActivityBySession] = useState<Record<string, LiveActivitySnapshot>>({});
  const [lastChatActivityAt, setLastChatActivityAt] = useState<number | null>(null);
  const [chatStatus, setChatStatus] = useState<string | null>(null);
  const [compactFeedback, setCompactFeedback] = useState<CompactFeedbackState | null>(null);
  const [sessionPickerOpen, setSessionPickerOpen] = useState(false);
  const [commandPickerOpen, setCommandPickerOpen] = useState(false);
  const [chatCommands, setChatCommands] = useState<SlashCommandSummary[]>([]);
  const [chatCommandsStatus, setChatCommandsStatus] = useState<'idle' | 'loading' | 'loaded' | 'error'>('idle');
  const [chatCommandsError, setChatCommandsError] = useState<string | null>(null);
  const [chatSessionMenuOpen, setChatSessionMenuOpen] = useState(false);
  const [chatSessionReasoningPopover, setChatSessionReasoningPopover] = useState<{
    sessionId: string;
    anchor: 'menu' | 'badge';
  } | null>(null);
  const [chatSessionCompactPopover, setChatSessionCompactPopover] = useState<{
    sessionId: string;
  } | null>(null);
  const [chatSessionReasoningPendingSessionId, setChatSessionReasoningPendingSessionId] = useState<string | null>(null);
  const [chatSessionActionPending, setChatSessionActionPending] = useState<'reset' | 'delete' | null>(null);
  const [compactingSessionIds, setCompactingSessionIds] = useState<Record<string, ChatSessionCompactionState>>({});
  const [renameSessionId, setRenameSessionId] = useState<string | null>(null);
  const [renameSessionTitle, setRenameSessionTitle] = useState('');
  const [renameSessionError, setRenameSessionError] = useState<string | null>(null);
  const [isRenamingSession, setIsRenamingSession] = useState(false);
  const [isCreateSessionModalOpen, setIsCreateSessionModalOpen] = useState(false);
  const [newSessionProvider, setNewSessionProvider] = useState<BrainProviderName>('claude');
  const [newSessionClaudeReasoningEffort, setNewSessionClaudeReasoningEffort] = useState<ClaudeReasoningEffort>('high');
  const [newSessionCodexReasoningEffort, setNewSessionCodexReasoningEffort] = useState<CodexReasoningEffort>('high');
  const [newSessionCodexFastMode, setNewSessionCodexFastMode] = useState(false);
  const [newSessionType, setNewSessionType] = useState<'curator' | 'normal'>('normal');
  const [newSessionTitle, setNewSessionTitle] = useState('');
  const [newSessionColor, setNewSessionColor] = useState<string | null>(null);
  const [newSessionWorkingDirectory, setNewSessionWorkingDirectory] = useState('');
  const [newSessionModalError, setNewSessionModalError] = useState<string | null>(null);
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const [isSendingChat, setIsSendingChat] = useState(false);
  const [isStartingSetupWizard, setIsStartingSetupWizard] = useState(false);
  const [isStartingSourceHealth, setIsStartingSourceHealth] = useState(false);
  const [isSetupReady, setIsSetupReady] = useState(false);
  const [isUploadingChatAttachments, setIsUploadingChatAttachments] = useState(false);
  const [isChatAttachmentDragActive, setIsChatAttachmentDragActive] = useState(false);
  const [hasLoadedSelectedSessionId, setHasLoadedSelectedSessionId] = useState(false);
  const [conversationHighlightId, setConversationHighlightId] = useState<string | null>(null);
  const [conversationScrollToBottomId, setConversationScrollToBottomId] = useState<string | null>(null);
  const [conversationScrollToMessage, setConversationScrollToMessage] = useState<{ sessionId: string; messageId: string } | null>(null);
  const [, setLiveBrainTranscript] = useState<{ taskId: string; text: string } | null>(null);
  const [taskTranscripts, setTaskTranscripts] = useState<Record<string, string>>({});
  const [taskTranscriptFallbacks, setTaskTranscriptFallbacks] = useState<Record<string, TaskTranscriptFallbackState>>({});
  const [expandedAgentTranscript, setExpandedAgentTranscript] = useState<AgentTranscriptTarget | null>(null);
  const [agentTranscripts, setAgentTranscripts] = useState<Record<string, AgentTranscriptState>>({});
  const [feedBannerCompletedTask, setFeedBannerCompletedTask] = useState<OrchestratorTaskStatus | null>(null);
  const prevActiveNonChatTaskIdRef = useRef<string | null>(null);
  const [isMobileViewport, setIsMobileViewport] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [mobileKeyboardInset, setMobileKeyboardInset] = useState(0);
  const [chatComposerHeight, setChatComposerHeight] = useState(0);
  const [chatComposerElement, setChatComposerElement] = useState<HTMLDivElement | null>(null);
  const [chatInputElement, setChatInputElement] = useState<HTMLDivElement | null>(null);
  const [headerMeasuredHeight, setHeaderMeasuredHeight] = useState(APP_HEADER_HEIGHT_FALLBACK_PX);
  const [detailStack, setDetailStack] = useState<DetailViewEntry[]>([]);

  const offsetRef = useRef(0);
  const isFetchingRef = useRef(false);
  const itemsRef = useRef<FeedItem[]>([]);
  const pendingItemsRef = useRef<FeedItem[]>([]);
  const chatMessagesRef = useRef<ChatMessage[]>([]);
  const conversationSessionsRef = useRef<ConversationSessionSummary[]>([]);
  const conversationSessionNextOffsetRef = useRef(0);
  const hydratedConversationSessionIdsRef = useRef<Set<string>>(new Set());
  const selectedSessionIdRef = useRef<string | null>(null);
  const selectedSessionAutoCorrectionPausedUntilRef = useRef(0);
  const skipSelectedSessionAutoCorrectionRef = useRef(false);
  const streamingChatRef = useRef<StreamingChatState | null>(null);
  const streamingSupersededRef = useRef(false);
  const conversationRefreshTimerRef = useRef<number | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const chatInputRef = useRef<HTMLDivElement | null>(null);
  const sessionPickerRef = useRef<HTMLDivElement | null>(null);
  const chatSessionMenuRef = useRef<HTMLDivElement | null>(null);
  const chatSessionReasoningPopoverRef = useRef<HTMLDivElement | null>(null);
  const chatSessionCompactPopoverRef = useRef<HTMLDivElement | null>(null);
  const chatAttachmentInputRef = useRef<HTMLInputElement | null>(null);
  const chatAttachmentDragDepthRef = useRef(0);
  const feedFetchVersionRef = useRef(0);
  const hasMountedFeedControlsRef = useRef(false);
  const appHeaderRef = useRef<HTMLElement | null>(null);
  const detailStackRef = useRef<DetailViewEntry[]>([]);
  const detailPostItemsRef = useRef<Map<string, FeedItem>>(new Map());
  const detailEntryIdRef = useRef(0);

  const brainState = useMemo(() => resolveBrainState(activity, orchestratorStatus), [activity, orchestratorStatus]);
  const curatorSessions = useMemo(
    () => conversationSessions.filter((session) => session.sessionType === 'curator'),
    [conversationSessions],
  );
  const hasCuratorSession = curatorSessions.length > 0;
  const hasSourceSkillInstalled = useMemo(() => skillsFeedSources.length > 0, [skillsFeedSources]);
  const hasTweetSource = useMemo(() => hasTweetFeedSource(skillsFeedSources), [skillsFeedSources]);
  const baseFeedFilters = useMemo(
    () => buildBaseFeedFilters({ hasTweetSource, hasCuratorSession }),
    [hasCuratorSession, hasTweetSource],
  );
  const sourceFilters = useMemo(
    () => buildDynamicFeedSourceFilters(skillsFeedSources),
    [skillsFeedSources],
  );
  const feedFilters = useMemo(
    () => [...baseFeedFilters, ...sourceFilters],
    [baseFeedFilters, sourceFilters],
  );
  const headerFilters = useMemo(
    () => buildHeaderFeedFilters(baseFeedFilters),
    [baseFeedFilters],
  );
  const feedFiltersByValue = useMemo(
    () => new Map(feedFilters.map((filter) => [filter.value, filter])),
    [feedFilters],
  );
  const sourceFilterValues = useMemo(
    () => new Set(sourceFilters.map((filter) => filter.value)),
    [sourceFilters],
  );
  const isSourceFilter = useCallback(
    (filter: FeedFilter): boolean => sourceFilterValues.has(filter),
    [sourceFilterValues],
  );
  const pinnedHeaderValues = useMemo(() => headerFilters.map((filter) => filter.value), [headerFilters]);
  const visibleHeaderFilters = useMemo(() => {
    if (selectedFilter === 'all' || pinnedHeaderValues.includes(selectedFilter)) {
      return headerFilters;
    }
    return [...pinnedHeaderValues.slice(0, -1), selectedFilter]
      .map((value) => feedFiltersByValue.get(value))
      .filter((filter): filter is FeedFilterOption => Boolean(filter));
  }, [feedFiltersByValue, headerFilters, pinnedHeaderValues, selectedFilter]);
  const mobilePinnedHeaderFilters = useMemo(() => {
    const analysisFilter = headerFilters.find((filter) => filter.value === 'analysis');
    return [
      ...headerFilters.slice(0, 3),
      ...(analysisFilter ? [analysisFilter] : []),
    ];
  }, [headerFilters]);
  const mobilePinnedHeaderValues = useMemo(
    () => mobilePinnedHeaderFilters.map((filter) => filter.value),
    [mobilePinnedHeaderFilters],
  );
  const mobileHeaderFilters = useMemo(() => {
    if (selectedFilter === 'all' || mobilePinnedHeaderValues.includes(selectedFilter)) {
      return mobilePinnedHeaderFilters;
    }
    return [...mobilePinnedHeaderValues.slice(0, -1), selectedFilter]
      .map((value) => feedFiltersByValue.get(value))
      .filter((filter): filter is FeedFilterOption => Boolean(filter));
  }, [feedFiltersByValue, mobilePinnedHeaderFilters, mobilePinnedHeaderValues, selectedFilter]);
  const desktopHeaderFilters = visibleHeaderFilters;
  const fallbackChatProgress = useMemo(
    () => (chatProgress ? null : getFallbackChatProgress(orchestratorStatus)),
    [chatProgress, orchestratorStatus],
  );
  const effectiveChatProgress = chatProgress ?? fallbackChatProgress;
  const hasActiveChatTask = useMemo(() => getActiveChatTasks(orchestratorStatus).length > 0, [orchestratorStatus]);
  const hasActiveSearch = Boolean(searchQuery);
  const feedRequestLimit = useMemo(() => (
    selectedFilter === 'suggestion' ? SUGGESTION_PAGE_SIZE : PAGE_SIZE
  ), [selectedFilter]);
  const visibleStreamingChat = hasDeliveredStreamingReply(
    chatMessages,
    streamingChat,
    streamingSupersededRef.current,
  ) ? null : streamingChat;
  const persistSelectedChatSessionId = useCallback((sessionId: string | null) => {
    if (sessionId?.trim()) {
      window.localStorage.setItem(SELECTED_CHAT_SESSION_STORAGE_KEY, sessionId);
      return;
    }
    window.localStorage.removeItem(SELECTED_CHAT_SESSION_STORAGE_KEY);
  }, []);
  const pauseSelectedChatSessionAutoCorrection = useCallback((durationMs = SELECTED_CHAT_SESSION_AUTOCORRECT_GRACE_MS) => {
    selectedSessionAutoCorrectionPausedUntilRef.current = Date.now() + durationMs;
  }, []);
  const updateSelectedChatSession = useCallback((
    nextSessionIdOrUpdater: string | null | ((current: string | null) => string | null),
    options?: { pauseAutoCorrection?: boolean; persist?: boolean },
  ) => {
    const current = selectedSessionIdRef.current;
    const resolvedNextSessionId = typeof nextSessionIdOrUpdater === 'function'
      ? nextSessionIdOrUpdater(current)
      : nextSessionIdOrUpdater;
    const normalizedNextSessionId = resolvedNextSessionId?.trim() ? resolvedNextSessionId : null;
    const shouldPauseAutoCorrection = options?.pauseAutoCorrection ?? true;
    const shouldPersist = options?.persist ?? true;

    if (shouldPauseAutoCorrection) {
      pauseSelectedChatSessionAutoCorrection();
    }

    if (normalizedNextSessionId === current) {
      if (shouldPersist) {
        persistSelectedChatSessionId(normalizedNextSessionId);
      }
      return normalizedNextSessionId;
    }

    selectedSessionIdRef.current = normalizedNextSessionId;
    setSelectedSessionId(normalizedNextSessionId);

    if (shouldPersist) {
      persistSelectedChatSessionId(normalizedNextSessionId);
    }

    return normalizedNextSessionId;
  }, [pauseSelectedChatSessionAutoCorrection, persistSelectedChatSessionId]);
  const markChatActivity = useCallback(() => {
    setLastChatActivityAt(Date.now());
  }, []);
  const appendSelectedFilterToFeedQuery = useCallback((query: URLSearchParams, filter: FeedFilter) => {
    appendFeedFilterToFeedQuery(query, filter, sourceFilterValues);
  }, [sourceFilterValues]);
  const rememberLiveActivity = useCallback((sessionId: string | null, snapshot: LiveActivitySnapshot | null) => {
    if (!sessionId || !snapshot) {
      return;
    }

    setRetainedLiveActivityBySession((current) => {
      const previous = current[sessionId];
      if (
        previous
        && previous.label === snapshot.label
        && previous.detail === snapshot.detail
        && previous.badge === snapshot.badge
        && previous.status === snapshot.status
      ) {
        return current;
      }

      return {
        ...current,
        [sessionId]: snapshot,
      };
    });
  }, []);
  const clearRetainedLiveActivity = useCallback((sessionId: string | null) => {
    if (!sessionId) {
      return;
    }

    setRetainedLiveActivityBySession((current) => {
      if (!(sessionId in current)) {
        return current;
      }

      const next = { ...current };
      delete next[sessionId];
      return next;
    });
  }, []);
  const clearDeliveredAgentChatState = useCallback((messages: ChatMessage[]): boolean => {
    const deliveredReplies = messages.filter((message) => message.role === 'agent' && message.type === 'chat');
    if (deliveredReplies.length === 0) {
      return false;
    }

    streamingSupersededRef.current = true;
    setBrainTyping(false);
    setChatProgress(null);
    setStreamingChat(null);
    setLastChatActivityAt(null);

    const sessionIds = new Set<string>();
    for (const message of deliveredReplies) {
      const sessionId = typeof message.sessionId === 'string' && message.sessionId.trim()
        ? message.sessionId.trim()
        : resolveChatSessionIdFromInReplyTo(chatMessagesRef.current, message.inReplyTo);
      if (sessionId) {
        sessionIds.add(sessionId);
      }
    }

    const activeStreamingSessionId = streamingChatRef.current?.sessionId;
    if (activeStreamingSessionId) {
      sessionIds.add(activeStreamingSessionId);
    }

    for (const sessionId of sessionIds) {
      clearRetainedLiveActivity(sessionId);
    }

    return true;
  }, [clearRetainedLiveActivity]);
  const handleChatComposerElement = useCallback((node: HTMLDivElement | null) => {
    setChatComposerElement(node);
  }, []);
  const closeCommandPicker = useCallback(() => {
    setCommandPickerOpen(false);
  }, []);
  const loadChatCommands = useCallback(async () => {
    setChatCommandsStatus('loading');
    setChatCommandsError(null);

    try {
      const response = await fetch('/api/commands', { cache: 'no-store' });
      const payload = await response.json() as SlashCommandSummary[] | { error?: string };

      if (!response.ok || !Array.isArray(payload)) {
        throw new Error(Array.isArray(payload) ? 'Failed to load commands' : payload.error || 'Failed to load commands');
      }

      setChatCommands(payload);
      setChatCommandsStatus('loaded');
    } catch (error) {
      setChatCommandsStatus('error');
      setChatCommandsError(error instanceof Error ? error.message : 'Failed to load commands');
    }
  }, []);
  const openCommandPicker = useCallback(() => {
    setSessionPickerOpen(false);
    setChatSessionMenuOpen(false);
    setCommandPickerOpen(true);
    if (chatCommandsStatus !== 'loaded') {
      void loadChatCommands();
    }
  }, [chatCommandsStatus, loadChatCommands]);
  const agentName = useMemo(() => {
    if (!configContent) return 'Agent';
    const match = configContent.match(/(?:^|\n)##\s+Agent Name\s*\n([^\n]+)/i);
    const resolvedName = match?.[1]?.trim();
    return resolvedName || 'Agent';
  }, [configContent]);
  const brainProviderInfo = useMemo(() => {
    const normalized = configContent?.match(/(?:^|\n)##\s+Brain Provider\s*\n([^\n]+)/i)?.[1]?.trim().toLowerCase() ?? '';
    const codexReasoningEffort = deriveCodexReasoningEffortFromConfig(configContent);
    if (normalized.includes('codex')) {
      return {
        provider: 'codex',
        providerDisplayName: 'Codex CLI',
        providerBinary: 'codex',
        codexReasoningEffort,
      } as const;
    }

    return {
      provider: 'claude',
      providerDisplayName: 'Claude Code',
      providerBinary: 'claude',
      codexReasoningEffort,
    } as const;
  }, [configContent]);
  const automaticCurationEnabled = useMemo(
    () => parseAutomaticCurationEnabled(configContent),
    [configContent],
  );
  const backgroundSourceBrowsingEnabled = useMemo(
    () => parseBackgroundSourceBrowsingEnabled(configContent),
    [configContent],
  );
  const codeFixReasoningEffort = useMemo(
    () => parseCodeFixReasoningEffort(configContent),
    [configContent],
  );
  const availableNewSessionProviders = useMemo(() => (
    (['claude', 'codex'] as const)
      .map((provider) => brainProviderStatus?.providers[provider] ?? null)
      .filter((provider): provider is BrainProviderAvailabilityState => Boolean(provider?.available))
      .map((provider) => ({
        value: provider.provider,
        label: provider.provider === 'codex' ? 'Codex' : provider.providerDisplayName,
      }))
  ), [brainProviderStatus]);
  useEffect(() => {
    if (isBrainProviderModalOpen || isSwitchingBrainProvider) {
      return;
    }

    setPendingBrainProvider(brainProviderInfo.provider);
    setPendingCodexReasoningEffort(brainProviderInfo.codexReasoningEffort);
  }, [
    brainProviderInfo.codexReasoningEffort,
    brainProviderInfo.provider,
    isBrainProviderModalOpen,
    isSwitchingBrainProvider,
  ]);
  useEffect(() => {
    if (!isCreateSessionModalOpen) {
      return;
    }

    if (availableNewSessionProviders.some((provider) => provider.value === newSessionProvider)) {
      return;
    }

    const fallbackProvider = availableNewSessionProviders[0]?.value;
    if (fallbackProvider) {
      setNewSessionProvider(fallbackProvider);
    }
  }, [availableNewSessionProviders, isCreateSessionModalOpen, newSessionProvider]);
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const response = await fetch('/api/skills', { cache: 'no-store' });
        const payload = await response.json() as SkillsApiResponse | { error?: string };
        if (!response.ok) {
          throw new Error((payload as { error?: string }).error || 'Failed to load skills');
        }
        if (!cancelled) {
          const feedSources: FeedSourceOption[] = Array.isArray((payload as SkillsApiResponse).feedSources)
            ? ((payload as SkillsApiResponse).feedSources ?? [])
            : [];
          setSkillsFeedSources(feedSources);
        }
      } catch {
        if (!cancelled) {
          setSkillsFeedSources([]);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (feedFilters.some((filter) => filter.value === selectedFilter)) {
      return;
    }
    setSelectedFilter('all');
  }, [feedFilters, selectedFilter]);
  const toggleAutomaticCuration = useCallback(async () => {
    if (!configContent || isSavingAutomaticCuration) {
      return;
    }

    const nextContent = updateAutomaticCurationConfigContent(
      configContent,
      !automaticCurationEnabled,
    );

    setIsSavingAutomaticCuration(true);
    setAutomaticCurationError(null);
    let response: Response | null = null;

    try {
      response = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: nextContent }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) {
        throw new Error(
          isAuthFailure(response, null)
            ? AUTH_REQUIRED_MESSAGE
            : payload.error || 'Failed to update automatic curation',
        );
      }

      setConfigContent(nextContent);
    } catch (error) {
      setAutomaticCurationError(
        isAuthFailure(response, error)
          ? AUTH_REQUIRED_MESSAGE
          : error instanceof Error
            ? error.message
            : 'Failed to update automatic curation',
      );
    } finally {
      setIsSavingAutomaticCuration(false);
    }
  }, [automaticCurationEnabled, configContent, isSavingAutomaticCuration]);
  const toggleBackgroundSourceBrowsing = useCallback(async () => {
    if (!configContent || isSavingBackgroundSourceBrowsing) {
      return;
    }

    const nextContent = updateBackgroundSourceBrowsingConfigContent(
      configContent,
      !backgroundSourceBrowsingEnabled,
    );

    setIsSavingBackgroundSourceBrowsing(true);
    setBackgroundSourceBrowsingError(null);
    let response: Response | null = null;

    try {
      response = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: nextContent }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) {
        throw new Error(
          isAuthFailure(response, null)
            ? AUTH_REQUIRED_MESSAGE
            : payload.error || 'Failed to update background source browsing',
        );
      }

      setConfigContent(nextContent);
    } catch (error) {
      setBackgroundSourceBrowsingError(
        isAuthFailure(response, error)
          ? AUTH_REQUIRED_MESSAGE
          : error instanceof Error
            ? error.message
            : 'Failed to update background source browsing',
      );
    } finally {
      setIsSavingBackgroundSourceBrowsing(false);
    }
  }, [backgroundSourceBrowsingEnabled, configContent, isSavingBackgroundSourceBrowsing]);
  const setCodeFixReasoningEffort = useCallback(async (nextValue: CodeFixReasoningEffort): Promise<boolean> => {
    if (!configContent || isSavingCodeFixReasoning) {
      return false;
    }
    if (nextValue === codeFixReasoningEffort) {
      return true;
    }

    const nextContent = updateCodeFixReasoningEffortConfigContent(configContent, nextValue);

    setIsSavingCodeFixReasoning(true);
    setCodeFixReasoningError(null);
    let response: Response | null = null;

    try {
      response = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: nextContent }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) {
        throw new Error(
          isAuthFailure(response, null)
            ? AUTH_REQUIRED_MESSAGE
            : payload.error || 'Failed to update code-fix reasoning effort',
        );
      }

      setConfigContent(nextContent);
      return true;
    } catch (error) {
      setCodeFixReasoningError(
        isAuthFailure(response, error)
          ? AUTH_REQUIRED_MESSAGE
          : error instanceof Error
            ? error.message
            : 'Failed to update code-fix reasoning effort',
      );
      return false;
    } finally {
      setIsSavingCodeFixReasoning(false);
    }
  }, [codeFixReasoningEffort, configContent, isSavingCodeFixReasoning]);
  const resolveSuggestionStatus = useCallback((item: FeedItem): SuggestionStatus => {
    if (item.type !== 'suggestion') return 'pending';
    const override = suggestionStatusOverrides[item.id];
    if (override === 'merged' || override === 'failed' || override === 'dismissed') {
      return override;
    }
    const progress = codeFixProgressMap[item.id];
    if (
      isCodeFixSuggestion(item)
      && progress
      && progress.phase !== 'done'
      && progress.phase !== 'failed'
    ) {
      return 'running';
    }
    return override ?? item.suggestionStatus ?? 'pending';
  }, [codeFixProgressMap, suggestionStatusOverrides]);
  const normalizeSuggestionGroup = useCallback((group?: FeedSuggestionGroup | null): FeedSuggestionGroup | null => {
    if (!group || !Array.isArray(group.items) || group.items.length === 0) {
      return null;
    }

    const nextItems = buildSuggestionGroupItems(group.items, sortOrder);
    if (nextItems.length === 0) {
      return null;
    }

    return {
      title: group.title?.trim() || 'Suggestions',
      items: nextItems,
      latestTimestamp: getSuggestionGroupLatestTimestamp(nextItems),
      totalCount: typeof group.totalCount === 'number' && Number.isFinite(group.totalCount)
        ? Math.max(group.totalCount, nextItems.length)
        : nextItems.length,
    };
  }, [sortOrder]);
  const getRenderableSuggestionGroupItems = useCallback((group: FeedSuggestionGroup | null): FeedItem[] => {
    if (!group || group.items.length === 0) {
      return [];
    }

    return buildSuggestionGroupItems(
      group.items.map((item) => ({
        ...item,
        suggestionStatus: resolveSuggestionStatus(item),
      })),
      sortOrder,
    );
  }, [resolveSuggestionStatus, sortOrder]);
  const fetchRestartState = useCallback(async (): Promise<RestartLifecycleState | null> => {
    const res = await fetch('/api/internal/pending-restart', { cache: 'no-store' });
    if (!res.ok) {
      throw new Error(`Restart status request failed (${res.status})`);
    }

    const data = await res.json() as {
      state?: RestartLifecycleState | null;
      status?: RestartLifecycleStatus;
      commit?: string;
      summary?: string;
    };

    if (data.state && typeof data.state === 'object') {
      return data.state;
    }

    if (typeof data.status === 'string' && typeof data.summary === 'string') {
      return {
        status: data.status,
        commit: typeof data.commit === 'string' ? data.commit : null,
        summary: data.summary,
      } as RestartLifecycleState;
    }

    return null;
  }, []);
  const resolveInlineCodeFixSuggestionStatus = useCallback((
    conversation: ConversationCardViewModel,
    suggestion: InlineCodeFixChatSuggestion,
  ): SuggestionStatus => {
    const matchingFeedSuggestion = conversation.feedItems.find((item) => item.id === suggestion.id);
    return suggestionStatusOverrides[suggestion.id]
      ?? (matchingFeedSuggestion ? resolveSuggestionStatus(matchingFeedSuggestion) : suggestion.status);
  }, [resolveSuggestionStatus, suggestionStatusOverrides]);
  const shouldRenderItem = useCallback((item: FeedItem): boolean => {
    if (selectedFilter === 'agent') {
      return false;
    }
    if (shouldSuppressFeedSystemNotice(item)) {
      return false;
    }
    if (selectedFilter === 'notification') {
      const isNotification = item.type === 'notification';
      const isReflection = item.type === 'analysis' && item.metadata?.reflectionCycle === true;
      if (!isNotification && !isReflection) {
        return false;
      }
    } else if (isSourceFilter(selectedFilter)) {
      if (item.source !== selectedFilter) {
        return false;
      }
    } else if (selectedFilter !== 'all' && item.type !== selectedFilter) {
      return false;
    }
    if (
      item.type === 'suggestion'
      && selectedFilter !== 'suggestion'
      && resolveSuggestionStatus(item) === 'dismissed'
    ) {
      return false;
    }
    if (isDismissedNotification(item) || isExpiredNotification(item)) {
      return false;
    }
    return true;
  }, [isSourceFilter, resolveSuggestionStatus, selectedFilter]);

  const activeNonChatTask = useMemo(() => {
    if (!orchestratorStatus?.currentTask) return null;
    return orchestratorStatus.currentTask.priority === 'user_chat' ? null : orchestratorStatus.currentTask;
  }, [orchestratorStatus]);

  // Track recently completed non-chat tasks for feed banner linger
  useEffect(() => {
    const currentId = activeNonChatTask?.id ?? null;
    const prevId = prevActiveNonChatTaskIdRef.current;
    prevActiveNonChatTaskIdRef.current = currentId;

    if (prevId && !currentId) {
      // Task just completed — find it in history
      const completed = orchestratorStatus?.history?.find((t) => t.id === prevId);
      if (completed) {
        setFeedBannerCompletedTask(completed);
      }
    }
  }, [activeNonChatTask?.id, orchestratorStatus?.history]);

  useEffect(() => {
    if (!feedBannerCompletedTask) return;

    const completedTaskId = feedBannerCompletedTask.id;
    const timer = window.setTimeout(() => {
      setFeedBannerCompletedTask((current) => (current?.id === completedTaskId ? null : current));
    }, FEED_BANNER_COMPLETED_TASK_TIMEOUT_MS);

    return () => window.clearTimeout(timer);
  }, [feedBannerCompletedTask]);

  const feedBannerCurationTask: CurationTaskState | null = useMemo(() => {
    const task = activeNonChatTask ?? feedBannerCompletedTask;
    if (!task) return null;
    const isCuration = task.priority === 'heartbeat'
      || (task.priority === 'user_ping' && /\/curate|heartbeat:|curation cycle/i.test(task.messagePreview || ''));
    if (!isCuration) return null;
    const isActive = activeNonChatTask?.id === task.id;
    return {
      taskId: task.id,
      status: isActive ? 'running' : (task.state === 'failed' ? 'failed' : 'completed'),
      startedAt: task.startedAt || task.enqueuedAt,
      updatedAt: task.completedAt || task.startedAt || task.enqueuedAt,
      itemsAdded: null,
      error: task.error || null,
      transcriptTarget: resolveTaskTranscriptTarget(task.id, orchestratorStatus),
    };
  }, [activeNonChatTask, feedBannerCompletedTask, orchestratorStatus]);

  const conversationCards = useMemo(() => {
    return buildSessionCards(
      chatMessages,
      Array.from(normalizeFeedItems([...pendingItems, ...items]).values()),
      conversationSessions,
      orchestratorStatus,
      {
        searchQuery,
        chatSessionMatches: searchChatSessionMatches,
      },
    );
  }, [chatMessages, conversationSessions, items, orchestratorStatus, pendingItems, searchChatSessionMatches, searchQuery]);

  const conversationCardMap = useMemo(() => {
    const map: Record<string, ConversationCardViewModel> = {};
    for (const conversation of conversationCards) {
      map[conversation.sessionId] = conversation;
    }
    return map;
  }, [conversationCards]);

  const topDetailEntry = detailStack[detailStack.length - 1] ?? null;
  const isChatDetailOpen = topDetailEntry?.kind === 'chat';
  const openChatConversationId = isChatDetailOpen ? topDetailEntry.conversationId : null;
  const targetConversationId = selectedSessionId;
  const targetConversation = targetConversationId ? conversationCardMap[targetConversationId] ?? null : null;
  const targetSessionId = targetConversation?.sessionId ?? selectedSessionId;
  const targetSessionSummary = conversationSessions.find((session) => session.sessionId === targetSessionId) ?? null;
  const suggestionCreatorSessionTitles = useMemo<SuggestionCreatorSessionTitles>(() => {
    const titles: SuggestionCreatorSessionTitles = {};
    for (const session of conversationSessions) {
      const sessionId = session.sessionId.trim();
      const title = session.title.trim();
      if (sessionId && title) {
        titles[sessionId] = title;
      }
    }
    return titles;
  }, [conversationSessions]);
  const sessionPickerSessions = conversationSessions;
  const nextSessionDefaultTitle = useMemo(() => generateSessionTitle(conversationSessions.length), [conversationSessions.length]);
  const hasOpenDetailView = detailStack.length > 0;
  const pendingItemCount = hasActiveSearch ? 0 : pendingItems.length;
  const isCurationPipelineActive = hasActiveCurationTask(orchestratorStatus);
  const isCurateDisabled = isLoading || isCurationPipelineActive;

  const shouldShowAgentEntries = !hasActiveSearch && (selectedFilter === 'all' || selectedFilter === 'agent');
  const searchConversationIds = useMemo(() => (
    hasActiveSearch
      ? searchChatSessionMatches.map((match) => match.sessionId)
      : []
  ), [hasActiveSearch, searchChatSessionMatches]);

  const visibleFeedEntries = useMemo<FeedRenderEntry[]>(() => {
    const entries: FeedRenderEntry[] = [];
    const shouldRenderSuggestionEntries = selectedFilter === 'all'
      || selectedFilter === 'suggestion'
      || isSourceFilter(selectedFilter);
    const shouldRenderNotificationEntries = selectedFilter === 'all'
      || selectedFilter === 'notification'
      || isSourceFilter(selectedFilter);
    const oldestLoadedPrimaryFeedItemTimestamp = selectedFilter === 'agent'
      ? null
      : getOldestLoadedPrimaryFeedItemTimestamp(items, shouldRenderItem);
    const visibleThreadItems = items.filter((item) => (
      shouldRenderItem(item)
      && item.type !== 'suggestion'
      && item.type !== 'notification'
    ));
    const threadMemberGroups = new Map<string, FeedItem[]>();
    const threadGroupedItemIds = new Set<string>();

    for (const item of visibleThreadItems) {
      if (item.type === 'analysis') {
        continue;
      }

      const identity = getThreadGroupIdentity(item);
      if (!identity) {
        continue;
      }

      const current = threadMemberGroups.get(identity.key);
      if (current) {
        current.push(item);
      } else {
        threadMemberGroups.set(identity.key, [item]);
      }
    }

    const threadGroupEntries: ThreadGroupRenderEntry[] = [];

    for (const [groupKey, groupItems] of threadMemberGroups.entries()) {
      if (groupItems.length < 1) {
        continue;
      }

      const members = [...groupItems].sort((left, right) => {
        const byCreated = left.createdAt.localeCompare(right.createdAt);
        if (byCreated !== 0) {
          return byCreated;
        }
        return left.id.localeCompare(right.id);
      });
      const memberIds = new Set(members.map((item) => item.id));
      const identity = getThreadGroupIdentity(members[0]);
      if (!identity) {
        continue;
      }

      const analysisItems = visibleThreadItems
        .filter((item) => {
          if (item.type !== 'analysis' || item.parentId === null || !memberIds.has(item.parentId)) {
            return false;
          }

          const analysisIdentity = getThreadGroupIdentity(item);
          return analysisIdentity === null || analysisIdentity.key === groupKey;
        })
        .sort((left, right) => {
          const byCreated = left.createdAt.localeCompare(right.createdAt);
          if (byCreated !== 0) {
            return byCreated;
          }
          return left.id.localeCompare(right.id);
        });

      const headerCandidates = [...analysisItems, ...members].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      const threadTitle = headerCandidates
        .map((item) => readTrimmedMetadataString(item.metadata?.thread?.threadTitle))
        .find((value): value is string => Boolean(value))
        ?? 'Thread';
      const threadRationale = headerCandidates
        .map((item) => readTrimmedMetadataString(item.metadata?.thread?.threadRationale))
        .find((value): value is string => Boolean(value))
        ?? null;
      const threadProminence = getThreadGroupProminence(headerCandidates);
      const feedbackProbe = getThreadFeedbackProbe(headerCandidates);
      const sourceItemIds = getThreadSourceItemIds(members, feedbackProbe);
      const continuing = headerCandidates.some((item) => item.metadata?.thread?.continuing === true);
      const latestTimestamp = members.reduce((latest, item) => (
        item.createdAt.localeCompare(latest) > 0 ? item.createdAt : latest
      ), members[0].createdAt);

      for (const member of members) {
        threadGroupedItemIds.add(member.id);
      }
      for (const analysisItem of analysisItems) {
        threadGroupedItemIds.add(analysisItem.id);
      }

      threadGroupEntries.push({
        kind: 'thread-group',
        groupId: `thread:${groupKey}`,
        threadId: identity.threadId,
        cycleId: identity.cycleId,
        threadTitle,
        threadRationale,
        threadProminence,
        feedbackProbe,
        sourceItemIds,
        continuing,
        analysisItems,
        items: members,
        latestTimestamp,
      });
    }

    const renderableAnalysisEntries = buildAnalysisRenderableEntries(
      items.filter((item) => (
        item.type === 'analysis'
        && shouldRenderItem(item)
        && !threadGroupedItemIds.has(item.id)
      )),
    );

    const loadedSuggestionItems = shouldRenderSuggestionEntries
      ? items
          .filter((item) => item.type === 'suggestion' && shouldRenderItem(item))
          .sort((left, right) => compareFeedItems(left, right, sortOrder))
      : [];
    const groupedSuggestionItems = shouldRenderSuggestionEntries
      ? getRenderableSuggestionGroupItems(suggestionGroup)
      : [];
    let renderedSuggestionItems: FeedItem[];
    if (selectedFilter === 'suggestion' || isSourceFilter(selectedFilter)) {
      // Keep paginated suggestions as the base list, but pin current items from the
      // unpaginated group to the top until their pages are loaded.
      const loadedIds = new Set(loadedSuggestionItems.map((item) => item.id));
      const currentFromGroup = groupedSuggestionItems.filter(
        (item) => !loadedIds.has(item.id) && isCurrentSuggestionStatus(getSuggestionGroupStatus(item)),
      );
      renderedSuggestionItems = currentFromGroup.length > 0
        ? [...currentFromGroup, ...loadedSuggestionItems]
        : loadedSuggestionItems;
    } else {
      renderedSuggestionItems = groupedSuggestionItems.length > 0
        ? groupedSuggestionItems
        : loadedSuggestionItems;
    }
    const suggestionPreviewItems = selectedFilter === 'all'
      ? getSuggestionGroupPreviewItems(renderedSuggestionItems, items)
      : undefined;

    if (renderedSuggestionItems.length > 0) {
      entries.push({
        kind: 'group',
        groupId: 'suggestions',
        groupType: 'suggestion',
        title: selectedFilter === 'suggestion' ? buildSuggestionGroupTitle(renderedSuggestionItems) : 'Suggestions',
        items: renderedSuggestionItems,
        previewItems: suggestionPreviewItems,
        latestTimestamp: getSuggestionGroupLatestTimestamp(renderedSuggestionItems),
      });
    }

    // Group active notifications
    const activeNotifications = shouldRenderNotificationEntries
      ? items.filter((item) => item.type === 'notification' && shouldRenderItem(item))
      : [];

    if (activeNotifications.length > 0) {
      entries.push({
        kind: 'group',
        groupId: 'active-notifications',
        groupType: 'notification',
        title: getNotificationGroupTitle(),
        items: activeNotifications,
        latestTimestamp: activeNotifications[0]?.createdAt ?? null,
      });
    }

    // Track grouped item IDs to skip them from individual rendering
    const groupedItemIds = new Set<string>();
    for (const s of renderedSuggestionItems) groupedItemIds.add(s.id);
    for (const n of activeNotifications) groupedItemIds.add(n.id);
    for (const threadEntry of threadGroupEntries) {
      for (const item of threadEntry.items) {
        groupedItemIds.add(item.id);
      }
      for (const item of threadEntry.analysisItems) {
        groupedItemIds.add(item.id);
      }
      entries.push(threadEntry);
    }
    for (const analysisEntry of renderableAnalysisEntries) {
      if (analysisEntry.kind === 'item') {
        groupedItemIds.add(analysisEntry.item.id);
        entries.push({ kind: 'item', item: analysisEntry.item });
        continue;
      }

      for (const item of analysisEntry.items) {
        groupedItemIds.add(item.id);
      }

      entries.push({
        kind: 'analysis-series',
        series: analysisEntry,
      });
    }

    for (const item of items) {
      if (shouldRenderSuggestionEntries && item.type === 'suggestion') {
        continue;
      }

      if (groupedItemIds.has(item.id)) {
        continue;
      }

      if (shouldRenderItem(item)) {
        entries.push({ kind: 'item', item });
      }
    }

    if (hasActiveSearch) {
      for (const conversationId of searchConversationIds) {
        if (!conversationCardMap[conversationId]) {
          continue;
        }

        entries.push({
          kind: 'conversation',
          conversationId,
        });
      }
    } else if (shouldShowAgentEntries) {
      for (const conversation of conversationCards) {
        if (!shouldIncludeConversationTimelineEntry({
          selectedFilter,
          oldestLoadedPrimaryFeedItemTimestamp,
          conversationLastTimestamp: conversation.lastTimestamp,
        })) {
          continue;
        }

        entries.push({
          kind: 'conversation',
          conversationId: conversation.sessionId,
        });
      }
    }

    return entries.sort((left, right) => compareTimelineEntries(left, right, conversationCardMap));
  }, [
    conversationCardMap,
    conversationCards,
    getRenderableSuggestionGroupItems,
    hasActiveSearch,
    isSourceFilter,
    items,
    searchConversationIds,
    selectedFilter,
    shouldRenderItem,
    shouldShowAgentEntries,
    sortOrder,
    suggestionGroup,
  ]);

  const scrollFeedToTop = useCallback(() => {
    window.requestAnimationFrame(() => {
      window.scrollTo({ top: 0, behavior: 'auto' });
    });
  }, []);

  const handleFeedFilterClick = useCallback((nextFilter: FeedFilter) => {
    const action = resolveFeedFilterClickAction({
      selectedFilter,
      nextFilter,
      isFeedSurfaceVisible: !hasOpenDetailView && !showConfigEditor && !showPreferencesPanel,
    });

    if (action.shouldUpdateFilter) {
      setSelectedFilter(nextFilter);
    }

    if (action.shouldScrollFeedToTop) {
      scrollFeedToTop();
    }
  }, [hasOpenDetailView, scrollFeedToTop, selectedFilter, showConfigEditor, showPreferencesPanel]);

  // Re-render every 60s so relative timestamps stay fresh
  useEffect(() => {
    const iv = setInterval(() => setTick(t => t + 1), 60_000);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  useEffect(() => {
    pendingItemsRef.current = pendingItems;
  }, [pendingItems]);

  useEffect(() => {
    chatMessagesRef.current = chatMessages;
  }, [chatMessages]);

  useEffect(() => {
    conversationSessionsRef.current = conversationSessions;
  }, [conversationSessions]);

  useEffect(() => {
    selectedSessionIdRef.current = selectedSessionId;
  }, [selectedSessionId]);

  useEffect(() => {
    detailStackRef.current = detailStack;
  }, [detailStack]);

  useEffect(() => {
    if (!selectedSessionId) return;
    if (conversationSessions.some((session) => session.sessionId === selectedSessionId)) return;
    if (!hasLoadedSelectedSessionId || isSendingChat) return;
    if (skipSelectedSessionAutoCorrectionRef.current) {
      skipSelectedSessionAutoCorrectionRef.current = false;
      return;
    }
    if (Date.now() < selectedSessionAutoCorrectionPausedUntilRef.current) return;
    updateSelectedChatSession(conversationSessions[0]?.sessionId ?? null, { pauseAutoCorrection: false });
  }, [conversationSessions, hasLoadedSelectedSessionId, isSendingChat, selectedSessionId, updateSelectedChatSession]);

  useEffect(() => {
    if (selectedSessionId || !conversationSessions[0]?.sessionId) return;
    if (!hasLoadedSelectedSessionId || isSendingChat) return;
    if (skipSelectedSessionAutoCorrectionRef.current) {
      skipSelectedSessionAutoCorrectionRef.current = false;
      return;
    }
    if (Date.now() < selectedSessionAutoCorrectionPausedUntilRef.current) return;
    updateSelectedChatSession(conversationSessions[0].sessionId, { pauseAutoCorrection: false });
  }, [conversationSessions, hasLoadedSelectedSessionId, isSendingChat, selectedSessionId, updateSelectedChatSession]);

  useEffect(() => {
    if (!conversationHighlightId) return;
    const timer = window.setTimeout(() => setConversationHighlightId(null), 2_000);
    return () => window.clearTimeout(timer);
  }, [conversationHighlightId]);

  useEffect(() => {
    let cancelled = false;

    async function fetchSetupReadiness() {
      try {
        const response = await fetch('/api/setup-readiness', { cache: 'no-store' });
        if (!response.ok) {
          return;
        }
        const data = await response.json() as SetupReadinessResponse;
        if (!cancelled) {
          setIsSetupReady(data.setupReady === true && (data.required?.length ?? 0) === 0);
        }
      } catch {
        // Keep the setup card visible when readiness cannot be verified.
      }
    }

    void fetchSetupReadiness();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!commandPickerOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeCommandPicker();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [closeCommandPicker, commandPickerOpen]);

  useEffect(() => {
    if (!chatSessionMenuOpen && !chatSessionReasoningPopover && !chatSessionCompactPopover) return;
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      const insideMenu = Boolean(chatSessionMenuRef.current?.contains(target));
      const insideReasoningPopover = Boolean(chatSessionReasoningPopoverRef.current?.contains(target));
      const insideCompactPopover = Boolean(chatSessionCompactPopoverRef.current?.contains(target));
      if (insideMenu || insideReasoningPopover || insideCompactPopover) {
        return;
      }
      setChatSessionMenuOpen(false);
      setChatSessionReasoningPopover(null);
      setChatSessionCompactPopover(null);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [chatSessionCompactPopover, chatSessionMenuOpen, chatSessionReasoningPopover]);

  useEffect(() => {
    if (!chatSessionReasoningPopover && !chatSessionCompactPopover) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      setChatSessionReasoningPopover(null);
      setChatSessionCompactPopover(null);
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [chatSessionCompactPopover, chatSessionReasoningPopover]);

  useEffect(() => {
    if (isChatDetailOpen && targetSessionId) return;
    setChatSessionMenuOpen(false);
    setChatSessionReasoningPopover(null);
    setChatSessionCompactPopover(null);
  }, [isChatDetailOpen, targetSessionId]);

  // Keep the session dropdown in sync with the open chat detail view
  useEffect(() => {
    if (!isChatDetailOpen || !openChatConversationId) return;
    const card = conversationCardMap[openChatConversationId];
    const detailSessionId = card?.sessionId ?? openChatConversationId;
    if (detailSessionId && detailSessionId !== selectedSessionId) {
      updateSelectedChatSession(detailSessionId);
    }
  }, [conversationCardMap, isChatDetailOpen, openChatConversationId, selectedSessionId, updateSelectedChatSession]);

  useEffect(() => {
    streamingChatRef.current = streamingChat;
  }, [streamingChat]);

  // Fallback: if a user message is pending (waiting for agent reply) and no
  // chat_update WS message arrives, poll the chat API every 3 seconds.
  // This handles Cloudflare tunnel WebSocket buffering/dropping.
  useEffect(() => {
    // Find the most recent user message that hasn't been replied to
    const lastUserMsg = [...chatMessages].reverse().find(m => m.role === 'user' && m.type === 'chat');
    if (!lastUserMsg) return;
    const hasReply = chatMessages.some(m => m.role === 'agent' && m.type === 'chat' && m.inReplyTo === lastUserMsg.id);
    if (hasReply) return;

    // User message is pending — poll until we get the reply
    const timer = setInterval(async () => {
      try {
        const res = await fetch('/api/chat/messages?limit=10');
        if (!res.ok) return;
        const data = (await res.json()) as { items?: ChatMessage[] };
        if (Array.isArray(data.items) && data.items.length > 0) {
          setChatMessages((current) => mergeChatMessages(current, data.items as ChatMessage[]));
          // Clear streaming/typing state if reply arrived
          const gotReply = (data.items as ChatMessage[]).some(
            m => m.role === 'agent' && m.type === 'chat' && m.inReplyTo === lastUserMsg.id
          );
          if (gotReply) {
            clearDeliveredAgentChatState(data.items as ChatMessage[]);
          }
        }
      } catch { /* ignore poll failures */ }
    }, 3000);

    return () => clearInterval(timer);
  }, [chatMessages, clearDeliveredAgentChatState]);

  useEffect(() => {
    let cancelled = false;

    const syncRestartState = async () => {
      try {
        const nextState = await fetchRestartState();
        if (cancelled) {
          return;
        }
        setRestartState(nextState);
        setIsApplyingRestart(nextState?.status === 'applying' || nextState?.status === 'restarting');
      } catch {
        if (cancelled) {
          return;
        }
      }
    };

    void syncRestartState();
    const timer = window.setInterval(() => {
      void syncRestartState();
    }, RESTART_STATUS_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [fetchRestartState]);

  useEffect(() => {
    if (!restartReloadPending) {
      return undefined;
    }

    let cancelled = false;
    const deadline = Date.now() + RESTART_APPLY_WAIT_TIMEOUT_MS;

    const waitForRestart = async () => {
      while (!cancelled && Date.now() < deadline) {
        try {
          const nextState = await fetchRestartState();
          if (cancelled) {
            return;
          }

          setRestartState(nextState);

          const status = nextState?.status;
          if (status === 'failed') {
            setIsApplyingRestart(false);
            setRestartReloadPending(false);
            return;
          }

          if (status === 'consumed' && nextState?.serviceReadyAt) {
            window.location.reload();
            return;
          }
        } catch {
          // The server can be unavailable while the service is restarting.
        }

        await new Promise((resolve) => window.setTimeout(resolve, RESTART_APPLY_POLL_INTERVAL_MS));
      }

      if (!cancelled) {
        setIsApplyingRestart(false);
        setRestartReloadPending(false);
      }
    };

    void waitForRestart();

    return () => {
      cancelled = true;
    };
  }, [fetchRestartState, restartReloadPending]);

  // Remove stale pending entries once those items are already visible in-feed.
  useEffect(() => {
    if (pendingItems.length === 0) return;

    const visibleIds = new Set(items.map((item) => item.id));
    const stillPending = pendingItems.filter((item) => !visibleIds.has(item.id));

    if (stillPending.length < pendingItems.length) {
      setPendingItems(stillPending);
    }
  }, [items, pendingItems]);

  useEffect(() => {
    const storedSessionId = window.localStorage.getItem(SELECTED_CHAT_SESSION_STORAGE_KEY);
    skipSelectedSessionAutoCorrectionRef.current = true;
    updateSelectedChatSession(storedSessionId?.trim() ? storedSessionId : null, {
      pauseAutoCorrection: false,
      persist: false,
    });
    setHasLoadedSelectedSessionId(true);
  }, [updateSelectedChatSession]);

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const initialSearchQuery = normalizeFeedSearchQuery(query.get('q'));
    setSearchDraft(initialSearchQuery);
    setSearchQuery(initialSearchQuery || null);
    setHasLoadedSearchQuery(true);
  }, []);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 639px)');
    const handleChange = () => setIsMobileViewport(mediaQuery.matches);

    handleChange();

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', handleChange);
      return () => mediaQuery.removeEventListener('change', handleChange);
    }

    mediaQuery.addListener(handleChange);
    return () => mediaQuery.removeListener(handleChange);
  }, []);

  useEffect(() => {
    if (!isMobileViewport) {
      setMobileKeyboardInset(0);
      return;
    }

    const updateKeyboardInset = () => {
      const layoutViewportHeight = window.innerHeight;
      const viewportHeight = window.visualViewport?.height ?? layoutViewportHeight;
      const viewportOffsetTop = window.visualViewport?.offsetTop ?? 0;
      const nextKeyboardInset = Math.max(0, Math.round(layoutViewportHeight - (viewportHeight + viewportOffsetTop)));
      setMobileKeyboardInset((current) => (
        Math.round(current) === nextKeyboardInset ? current : nextKeyboardInset
      ));
    };

    updateKeyboardInset();
    window.addEventListener('resize', updateKeyboardInset);
    window.addEventListener('orientationchange', updateKeyboardInset);
    window.addEventListener('focusin', updateKeyboardInset);
    window.addEventListener('focusout', updateKeyboardInset);
    window.visualViewport?.addEventListener('resize', updateKeyboardInset);
    window.visualViewport?.addEventListener('scroll', updateKeyboardInset);

    return () => {
      window.removeEventListener('resize', updateKeyboardInset);
      window.removeEventListener('orientationchange', updateKeyboardInset);
      window.removeEventListener('focusin', updateKeyboardInset);
      window.removeEventListener('focusout', updateKeyboardInset);
      window.visualViewport?.removeEventListener('resize', updateKeyboardInset);
      window.visualViewport?.removeEventListener('scroll', updateKeyboardInset);
    };
  }, [isMobileViewport]);

  useEffect(() => {
    if (!isMobileViewport) return;
    if (document.activeElement !== chatInputRef.current) return;

    chatInputRef.current?.scrollIntoView({ block: 'end' });
  }, [isMobileViewport, mobileKeyboardInset]);

  useLayoutEffect(() => {
    if (!chatComposerElement) {
      setChatComposerHeight(0);
      return;
    }

    const updateComposerHeight = () => {
      const nextHeight = Math.round(chatComposerElement.getBoundingClientRect().height);
      setChatComposerHeight((current) => (current === nextHeight ? current : nextHeight));
    };

    updateComposerHeight();

    const observer = new ResizeObserver(() => {
      updateComposerHeight();
    });
    observer.observe(chatComposerElement);

    return () => {
      observer.disconnect();
    };
  }, [chatComposerElement]);

  // Measure the app header height so the chat overlay starts below it
  useEffect(() => {
    const element = appHeaderRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setHeaderMeasuredHeight(Math.round(entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height));
      }
    });
    observer.observe(element);
    setHeaderMeasuredHeight(Math.round(element.getBoundingClientRect().height));
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!hasMountedFeedControlsRef.current) {
      hasMountedFeedControlsRef.current = true;
      return;
    }
    scrollFeedToTop();
  }, [searchQuery, selectedFilter, sortOrder, scrollFeedToTop]);

  const postActivity = useCallback(async (event: ActivityEvent, metadata?: Record<string, unknown>) => {
    try {
      await fetch('/api/activity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event,
          ...(metadata ? { metadata } : {}),
        }),
      });
    } catch {
      // best effort activity tracking
    }
  }, []);

  const adjustPendingCounts = useCallback((changes: Partial<Record<'suggestion' | 'notification', number>>) => {
    setPendingCounts((current) => ({
      ...current,
      suggestion: Math.max(0, current.suggestion + (changes.suggestion ?? 0)),
      notification: Math.max(0, current.notification + (changes.notification ?? 0)),
    }));
  }, []);

  const syncFeedSearchQueryParam = useCallback((nextSearchQuery: string | null, historyMode: 'push' | 'replace') => {
    const currentUrl = new URL(window.location.href);
    if (nextSearchQuery) {
      currentUrl.searchParams.set('q', nextSearchQuery);
    } else {
      currentUrl.searchParams.delete('q');
    }

    const nextUrl = `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`;
    if (historyMode === 'push') {
      window.history.pushState(window.history.state, '', nextUrl);
      return;
    }

    window.history.replaceState(window.history.state, '', nextUrl);
  }, []);

  const commitSearchQuery = useCallback((rawValue: string, historyMode: 'push' | 'replace' = 'push') => {
    const normalizedQuery = normalizeFeedSearchQuery(rawValue);
    const nextSearchQuery = normalizedQuery || null;

    setSearchDraft(normalizedQuery);
    setSearchQuery(nextSearchQuery);
    syncFeedSearchQueryParam(nextSearchQuery, historyMode);
  }, [syncFeedSearchQueryParam]);

  const fetchFeed = useCallback(async (reset: boolean) => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;
    const fetchVersion = reset ? feedFetchVersionRef.current + 1 : feedFetchVersionRef.current;
    if (reset) {
      feedFetchVersionRef.current = fetchVersion;
    }

    if (reset) {
      setIsLoading(true);
      offsetRef.current = 0;
      setHasMore(true);
      setPendingItems([]);
      setSuggestionGroup(null);
      setSuggestionStatusOverrides({});
      setCodeFixProgressMap({});
      setSuggestionPendingActions({});
      setSuggestionFeedback({});
      setNotificationPendingActions({});
      setNotificationFeedback({});
      setSearchChatSessionMatches([]);
    } else {
      setIsLoadingMore(true);
    }

    try {
      const query = new URLSearchParams();
      query.set('offset', String(offsetRef.current));
      query.set('limit', String(feedRequestLimit));
      query.set('sort', sortOrder);
      if (searchQuery) {
        query.set('q', searchQuery);
      }
      appendSelectedFilterToFeedQuery(query, selectedFilter);

      const response = await fetch(`/api/feed?${query.toString()}`);
      if (!response.ok) throw new Error(`Error ${response.status}`);

      const data = (await response.json()) as FeedListResponse;
      setPendingCounts(normalizePendingCounts(data.pendingCounts));
      setSuggestionGroup(normalizeSuggestionGroup(data.suggestionGroup));
      const incomingChatSessionMatches = Array.isArray(data.chatSessionMatches) ? data.chatSessionMatches : [];
      if (reset || incomingChatSessionMatches.length > 0) {
        setSearchChatSessionMatches((current) => (
          reset
            ? mergeChatSessionSearchMatches([], incomingChatSessionMatches)
            : mergeChatSessionSearchMatches(current, incomingChatSessionMatches)
        ));
      }
      if (incomingChatSessionMatches.length > 0) {
        const matchedSessions = incomingChatSessionMatches
          .map((match) => match.session)
          .filter((session): session is ConversationSessionSummary => session !== null);
        if (matchedSessions.length > 0) {
          setConversationSessions((current) => mergeConversationSessions(current, matchedSessions));
        }
        const matchedMessages = incomingChatSessionMatches.flatMap((match) => match.messages);
        if (matchedMessages.length > 0) {
          setChatMessages((current) => mergeChatMessages(current, matchedMessages));
        }
      }

      setItems((current) => {
        const merged = reset ? data.items : [...current, ...data.items];
        return Array.from(normalizeFeedItems(merged).values());
      });

      if (reset) {
        const fetchedIds = new Set(data.items.map((item) => item.id));
        setPendingItems((current) => {
          const remaining = current.filter((item) => !fetchedIds.has(item.id));
          return remaining.length === current.length ? current : remaining;
        });
      }

      offsetRef.current = reset ? data.items.length : offsetRef.current + data.items.length;
      setHasMore(data.hasMore);

      if (
        reset
        && !searchQuery
        && selectedFilter === 'all'
        && data.hasMore
        && countPrimaryFeedItems(data.items) < MIN_PRIMARY_FEED_ITEMS
      ) {
        void (async () => {
          let requestOffset = data.items.length;
          let combinedItems = data.items;
          let hasMore = data.hasMore;
          let batchCount = 1;
          let extraItems: FeedItem[] = [];

          while (
            hasMore
            && countPrimaryFeedItems(combinedItems) < MIN_PRIMARY_FEED_ITEMS
            && batchCount < MAX_RESET_FEED_BATCHES
            && feedFetchVersionRef.current === fetchVersion
          ) {
            const backfillQuery = new URLSearchParams();
            backfillQuery.set('offset', String(requestOffset));
            backfillQuery.set('limit', String(feedRequestLimit));
            backfillQuery.set('sort', sortOrder);
            appendSelectedFilterToFeedQuery(backfillQuery, selectedFilter);

            const backfillResponse = await fetch(`/api/feed?${backfillQuery.toString()}`);
            if (!backfillResponse.ok) {
              return;
            }

            const backfillPage = (await backfillResponse.json()) as {
              items: FeedItem[];
              hasMore: boolean;
            };

            if (feedFetchVersionRef.current !== fetchVersion) {
              return;
            }

            extraItems = [...extraItems, ...backfillPage.items];
            combinedItems = [...combinedItems, ...backfillPage.items];
            requestOffset += backfillPage.items.length;
            hasMore = backfillPage.hasMore;
            batchCount += 1;

            if (backfillPage.items.length === 0) {
              break;
            }
          }

          if (extraItems.length === 0 || feedFetchVersionRef.current !== fetchVersion) {
            return;
          }

          setItems((current) => Array.from(normalizeFeedItems([...current, ...extraItems]).values()));
          offsetRef.current = Math.max(offsetRef.current, data.items.length + extraItems.length);
          setHasMore(hasMore);
        })();
      }
    } catch {
      setHasMore(false);
    } finally {
      setIsLoading(false);
      setIsLoadingMore(false);
      isFetchingRef.current = false;
    }
  }, [appendSelectedFilterToFeedQuery, feedRequestLimit, normalizeSuggestionGroup, searchQuery, selectedFilter, sortOrder]);

  const refreshConversationSessionSummary = useCallback(async (sessionId: string | null) => {
    const normalizedSessionId = sessionId?.trim() ? sessionId.trim() : null;
    if (!normalizedSessionId) {
      return null;
    }

    try {
      const response = await fetch(`/api/chat/sessions?sessionId=${encodeURIComponent(normalizedSessionId)}`, {
        cache: 'no-store',
      });
      if (!response.ok) {
        throw new Error(`Error ${response.status}`);
      }

      const data = (await response.json()) as {
        session?: ConversationSessionSummary | null;
      };

      if (!data.session) {
        return null;
      }

      setConversationSessions((current) => mergeConversationSessions(current, [data.session as ConversationSessionSummary]));
      return data.session as ConversationSessionSummary;
    } catch {
      return null;
    }
  }, []);

  const loadConversationSessions = useCallback(async (options?: {
    reset?: boolean;
    ensureSessionId?: string | null;
  }) => {
    const reset = options?.reset ?? false;
    const ensureSessionId = options?.ensureSessionId?.trim() ? options.ensureSessionId.trim() : null;
    const offset = reset ? 0 : conversationSessionNextOffsetRef.current;

    setIsLoadingConversationSessions(true);
    try {
      const response = await fetch(`/api/chat/sessions?offset=${offset}&limit=${CONVERSATION_SESSION_PAGE_SIZE}`, {
        cache: 'no-store',
      });
      if (!response.ok) {
        throw new Error(`Error ${response.status}`);
      }

      const data = (await response.json()) as {
        sessions?: ConversationSessionSummary[];
        hasMore?: boolean;
        nextOffset?: number | null;
      };
      const pageSessions = Array.isArray(data.sessions) ? data.sessions : [];

      let mergedSessions = reset
        ? mergeConversationSessions([], pageSessions)
        : mergeConversationSessions(conversationSessionsRef.current, pageSessions);

      if (ensureSessionId && !mergedSessions.some((session) => session.sessionId === ensureSessionId)) {
        const ensuredSession = await refreshConversationSessionSummary(ensureSessionId);
        if (ensuredSession) {
          mergedSessions = mergeConversationSessions(mergedSessions, [ensuredSession]);
        }
      }

      conversationSessionNextOffsetRef.current = typeof data.nextOffset === 'number'
        ? data.nextOffset
        : offset + pageSessions.length;
      setConversationSessionsHasMore(Boolean(data.hasMore));
      setConversationSessions(mergedSessions);
      updateSelectedChatSession((current) => current ?? mergedSessions[0]?.sessionId ?? null, {
        pauseAutoCorrection: false,
        persist: hasLoadedSelectedSessionId,
      });
      return Boolean(data.hasMore);
    } catch {
      setConversationSessionsHasMore(false);
      setChatStatus('Failed to load session history');
      return false;
    } finally {
      setIsLoadingConversationSessions(false);
    }
  }, [hasLoadedSelectedSessionId, refreshConversationSessionSummary, updateSelectedChatSession]);

  const loadRecentChatMessages = useCallback(async () => {
    try {
      const response = await fetch('/api/chat/messages?limit=250', { cache: 'no-store' });
      if (!response.ok) throw new Error(`Error ${response.status}`);
      const data = (await response.json()) as {
        items: ChatMessage[];
      };
      setChatMessages((current) => mergeChatMessages(current, data.items));
      const activeStreamingState = streamingChatRef.current;
      if (activeStreamingState) {
        const shouldClearStreaming = data.items.some((item) => (
          item.role === 'agent'
          && item.type === 'chat'
          && (
            !activeStreamingState.inReplyTo
            || item.inReplyTo === activeStreamingState.inReplyTo
            || (
              activeStreamingState.sessionId
              && item.sessionId === activeStreamingState.sessionId
            )
          )
        ));
        if (shouldClearStreaming) {
          clearDeliveredAgentChatState(data.items);
        }
      }
    } catch {
      setChatStatus('Failed to load chat history');
    }
  }, [clearDeliveredAgentChatState]);

  const handleCancelOrchestratorTask = useCallback(async (taskId: string | null) => {
    if (!taskId) {
      return { ok: false, error: 'Task ID is required' } satisfies OrchestratorCancelResponse;
    }

    try {
      const result = await cancelOrchestratorTaskFromClient(taskId);
      if (result.ok && result.chatMessageId) {
        setChatMessages((current) => updateChatMessageStatus(current, result.chatMessageId, 'cancelled', ['pending', 'queued']));
      } else if (!result.ok) {
        setChatStatus(result.error || 'Failed to cancel task.');
      }

      if (result.ok) {
        void loadRecentChatMessages();
      }

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to cancel task.';
      setChatStatus(message);
      return { ok: false, error: message } satisfies OrchestratorCancelResponse;
    }
  }, [loadRecentChatMessages]);

  const loadSessionMessages = useCallback(async (
    sessionId: string | null,
    expectedMessageCount?: number | null,
  ) => {
    const normalizedSessionId = sessionId?.trim() ? sessionId.trim() : null;
    if (!normalizedSessionId) {
      return;
    }
    if (hydratedConversationSessionIdsRef.current.has(normalizedSessionId)) {
      return;
    }

    hydratedConversationSessionIdsRef.current.add(normalizedSessionId);
    const targetLimit = Math.max(
      CHAT_HISTORY_PAGE_SIZE,
      Math.min(expectedMessageCount ?? CHAT_HISTORY_PAGE_SIZE, 5_000),
    );

    try {
      const response = await fetch(
        `/api/chat/messages?sessionId=${encodeURIComponent(normalizedSessionId)}&limit=${targetLimit}`,
        { cache: 'no-store' },
      );
      if (!response.ok) {
        throw new Error(`Error ${response.status}`);
      }

      const data = (await response.json()) as {
        items: ChatMessage[];
      };
      setChatMessages((current) => mergeChatMessages(current, data.items));
      clearDeliveredAgentChatState(data.items);
    } catch {
      hydratedConversationSessionIdsRef.current.delete(normalizedSessionId);
      setChatStatus('Failed to load session messages');
    }
  }, [clearDeliveredAgentChatState]);

  useEffect(() => {
    if (!(selectedFilter === 'agent' || sessionPickerOpen)) return;
    if (!conversationSessionsHasMore || isLoadingConversationSessions) return;
    void loadConversationSessions();
  }, [
    conversationSessionsHasMore,
    isLoadingConversationSessions,
    loadConversationSessions,
    selectedFilter,
    sessionPickerOpen,
  ]);

  useEffect(() => {
    if (!selectedSessionId) return;
    const selectedSession = conversationSessions.find((session) => session.sessionId === selectedSessionId) ?? null;
    if (!selectedSession) return;
    if (selectedSession.messageCount === 0) return;
    void loadSessionMessages(selectedSession.sessionId, selectedSession.messageCount);
  }, [conversationSessions, loadSessionMessages, selectedSessionId]);

  const applyResetSessionLocally = useCallback((
    sessionId: string,
  ) => {
    setChatMessages((current) => current.filter((message) => message.sessionId !== sessionId));
    hydratedConversationSessionIdsRef.current.delete(sessionId);
    setConversationSessions((current) => current.map((session) => (
      session.sessionId === sessionId
        ? {
          ...session,
          messageCount: 0,
          latestContextTokens: null,
          latestContextWindow: null,
          latestContextModel: null,
          latestContextUpdatedAt: null,
          previewText: null,
          previewMessages: [],
          lastActor: null,
          contextKind: 'global',
          contextRefId: null,
          lastMaterialActivityAt: new Date().toISOString(),
        }
        : session
    )));
    setBrainTyping(false);
    setChatProgress(null);
    setStreamingChat(null);
    clearRetainedLiveActivity(sessionId);
  }, [clearRetainedLiveActivity]);

  const scheduleConversationRefresh = useCallback((delayMs = 80) => {
    if (conversationRefreshTimerRef.current !== null) {
      window.clearTimeout(conversationRefreshTimerRef.current);
    }
    conversationRefreshTimerRef.current = window.setTimeout(() => {
      conversationRefreshTimerRef.current = null;
      void loadRecentChatMessages();
    }, delayMs);
  }, [loadRecentChatMessages]);

  const applyIncomingFeedItems = useCallback((incoming: FeedItem[]) => {
    if (incoming.length === 0) return;
    if (incoming.some((item) => Boolean(item.originSessionId))) {
      scheduleConversationRefresh();
    }

    if (selectedFilter === 'all' || selectedFilter === 'suggestion') {
      const incomingSuggestions = incoming.filter((item) => item.type === 'suggestion');
      if (incomingSuggestions.length > 0) {
        setSuggestionGroup((current) => {
          const mergedItems = buildSuggestionGroupItems(
            [...(current?.items ?? []), ...incomingSuggestions],
            sortOrder,
          );
          if (mergedItems.length === 0) {
            return null;
          }

          return {
            title: current?.title || 'Suggestions',
            items: mergedItems,
            latestTimestamp: getSuggestionGroupLatestTimestamp(mergedItems),
            totalCount: Math.max(current?.totalCount ?? 0, mergedItems.length),
          };
        });
      }
    }

    // Separate items that should merge immediately from genuinely new items that stay pending.
    const visibleItemIds = new Set(itemsRef.current.map((item) => item.id));
    const visibleThreadIds = new Set(
      itemsRef.current
        .map((item) => readTrimmedMetadataString(item.metadata?.thread?.threadId))
        .filter((threadId): threadId is string => Boolean(threadId)),
    );
    const pendingItemIds = new Set(pendingItemsRef.current.map((item) => item.id));
    const immediateItems: FeedItem[] = [];
    const newItems: FeedItem[] = [];

    for (const item of incoming) {
      if (shouldSuppressFeedSystemNotice(item)) {
        continue;
      }
      if (visibleItemIds.has(item.id)) {
        immediateItems.push(item);
      } else if (pendingItemIds.has(item.id)) {
        continue;
      } else if (isDismissedNotification(item) || isExpiredNotification(item)) {
        continue;
      } else if (item.type === 'suggestion') {
        if (item.originSessionId) {
          immediateItems.push(item);
        }
        continue;
      } else if (item.type === 'notification') {
        // Notifications render from items, so merge them immediately instead of hiding them behind pending.
        immediateItems.push(item);
      } else if (!item.parentId) {
        // Only top-level items are visible in feed lists.
        const threadId = readTrimmedMetadataString(item.metadata?.thread?.threadId);
        if (threadId && visibleThreadIds.has(threadId)) {
          immediateItems.push(item);
        } else {
          newItems.push(item);
        }
      }
    }

    if (immediateItems.length > 0) {
      setItems((current) => {
        const map = normalizeFeedItems(current);

        for (const item of immediateItems) {
          const existing = map.get(item.id);
          map.set(item.id, existing ? { ...existing, ...item } : item);
        }

        return Array.from(map.values()).sort((a, b) => compareFeedItems(a, b, sortOrder));
      });
    }

    if (newItems.length > 0) {
      setPendingItems((currentPending) => {
        const map = normalizeFeedItems(currentPending);
        let didChange = false;

        for (const item of newItems) {
          if (!map.has(item.id)) {
            didChange = true;
          }
          map.set(item.id, item);
        }

        if (!didChange) {
          return currentPending;
        }

        return Array.from(map.values()).sort((a, b) => compareFeedItems(a, b, sortOrder));
      });
    }
  }, [scheduleConversationRefresh, selectedFilter, sortOrder]);

  const syncRecentFeedItems = useCallback(async () => {
    try {
      const query = new URLSearchParams();
      query.set('offset', '0');
      query.set('limit', String(feedRequestLimit));
      query.set('sort', sortOrder);
      if (searchQuery) {
        query.set('q', searchQuery);
      }
      appendSelectedFilterToFeedQuery(query, selectedFilter);

      const response = await fetch(`/api/feed?${query.toString()}`, { cache: 'no-store' });
      if (!response.ok) return;

      const data = (await response.json()) as FeedListResponse;
      setPendingCounts(normalizePendingCounts(data.pendingCounts));
      setSuggestionGroup(normalizeSuggestionGroup(data.suggestionGroup));
      if (searchQuery) {
        const nextItems = Array.isArray(data.items) ? data.items : [];
        setItems(nextItems);
        offsetRef.current = nextItems.length;
        setHasMore(data.hasMore);
        return;
      }

      if (!Array.isArray(data.items) || data.items.length === 0) return;

      applyIncomingFeedItems(data.items);
    } catch {
      // best effort realtime feed sync if websocket events are missed
    }
  }, [appendSelectedFilterToFeedQuery, applyIncomingFeedItems, feedRequestLimit, normalizeSuggestionGroup, searchQuery, selectedFilter, sortOrder]);

  const revealPendingItems = useCallback(() => {
    if (pendingItems.length === 0) return;

    setSelectedFilter('all');
    setItems((current) => {
      const existingIds = new Set(current.map((item) => item.id));
      const newItems = pendingItems
        .filter((item) => !existingIds.has(item.id))
        .sort((a, b) => compareFeedItems(a, b, sortOrder));
      return [...newItems, ...current];
    });
    setPendingItems([]);
    scrollFeedToTop();
  }, [pendingItems, scrollFeedToTop, sortOrder]);

  const clearChatAboutQueryParam = useCallback(() => {
    const currentUrl = new URL(window.location.href);
    if (!currentUrl.searchParams.has('chatAbout') && !currentUrl.searchParams.has('chatSelection')) return;
    currentUrl.searchParams.delete('chatAbout');
    currentUrl.searchParams.delete('chatSelection');
    const nextUrl = `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`;
    window.history.replaceState(window.history.state, '', nextUrl);
  }, []);

  const syncSelectedPostQueryParam = useCallback((postId: string | null, historyMode: 'push' | 'replace') => {
    const currentUrl = new URL(window.location.href);
    if (postId) {
      currentUrl.searchParams.set('post', postId);
    } else {
      currentUrl.searchParams.delete('post');
    }

    const nextUrl = `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`;
    const nextState = postId
      ? { ...(window.history.state ?? {}), evogentOverlayPost: true }
      : window.history.state;

    if (historyMode === 'push') {
      window.history.pushState(nextState, '', nextUrl);
      return;
    }

    window.history.replaceState(nextState, '', nextUrl);
  }, []);

  const makeDetailEntryKey = useCallback((kind: DetailViewEntry['kind']) => {
    detailEntryIdRef.current += 1;
    return `${kind}-${detailEntryIdRef.current}`;
  }, []);

  const openConversationDetail = useCallback((
    conversationId: string | null,
    contextPostId: string | null,
    options?: { replaceTop?: boolean },
  ) => {
    const normalizedContextPostId = contextPostId?.trim() ? contextPostId : null;
    setDetailStack((current) => {
      const topEntry = current[current.length - 1] ?? null;
      if (
        topEntry?.kind === 'chat'
        && topEntry.conversationId === conversationId
        && topEntry.contextPostId === normalizedContextPostId
      ) {
        return current;
      }

      const nextEntry: DetailViewEntry = {
        key: makeDetailEntryKey('chat'),
        kind: 'chat',
        conversationId,
        contextPostId: normalizedContextPostId,
      };

      if (options?.replaceTop && topEntry?.kind === 'chat') {
        return [...current.slice(0, -1), nextEntry];
      }

      return [...current, nextEntry];
    });
  }, [makeDetailEntryKey]);

  const applyDeletedSessionLocally = useCallback((
    sessionId: string,
    nextSessionId: string | null,
    sessions: ConversationSessionSummary[],
  ) => {
    setChatMessages((current) => current.filter((message) => message.sessionId !== sessionId));
    hydratedConversationSessionIdsRef.current.delete(sessionId);
    setConversationSessions(sessions);
    updateSelectedChatSession(nextSessionId);
    setBrainTyping(false);
    setChatProgress(null);
    setStreamingChat(null);
    clearRetainedLiveActivity(sessionId);

    if (openChatConversationId === sessionId) {
      const replacementConversation = nextSessionId ? conversationCardMap[nextSessionId] ?? null : null;
      openConversationDetail(
        nextSessionId,
        replacementConversation?.contextKind === 'post' ? replacementConversation.contextRefId : null,
        { replaceTop: true },
      );
    }
  }, [clearRetainedLiveActivity, conversationCardMap, openChatConversationId, openConversationDetail, updateSelectedChatSession]);

  const resetSelectedChatSession = useCallback(async (sessionId: string | null) => {
    if (!sessionId || chatSessionActionPending) return;
    if (!window.confirm('Reset this session? Chat history will be cleared.')) return;

    setChatSessionActionPending('reset');
    setChatStatus(null);
    setChatSessionMenuOpen(false);
    setChatSessionReasoningPopover(null);
    setChatSessionCompactPopover(null);

    try {
      const response = await fetch(`/api/chat/sessions/${encodeURIComponent(sessionId)}/reset`, {
        method: 'POST',
        cache: 'no-store',
      });
      const data = await response.json() as {
        error?: string;
      };

      if (!response.ok) {
        throw new Error(data.error || `Error ${response.status}`);
      }

      applyResetSessionLocally(sessionId);
      void loadConversationSessions({ reset: true, ensureSessionId: sessionId });
    } catch (error) {
      setChatStatus(error instanceof Error ? error.message : 'Failed to reset session');
    } finally {
      setChatSessionActionPending(null);
    }
  }, [applyResetSessionLocally, chatSessionActionPending, loadConversationSessions]);

  const deleteSelectedChatSession = useCallback(async (sessionId: string | null) => {
    if (!sessionId || chatSessionActionPending || conversationSessions.length <= 1) return;
    if (!window.confirm('Delete this session? This cannot be undone.')) return;

    setChatSessionActionPending('delete');
    setChatStatus(null);
    setChatSessionMenuOpen(false);
    setChatSessionReasoningPopover(null);
    setChatSessionCompactPopover(null);
    let response: Response | null = null;

    try {
      response = await fetch(`/api/chat/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
        cache: 'no-store',
      });
      const data = await response.json() as {
        error?: string;
        nextSessionId?: string | null;
      };

      if (!response.ok) {
        throw new Error(resolveChatFetchErrorMessage(response, null, data.error || `Error ${response.status}`));
      }

      const nextSessions = conversationSessionsRef.current.filter((session) => session.sessionId !== sessionId);
      applyDeletedSessionLocally(sessionId, data.nextSessionId ?? null, nextSessions);
      void loadConversationSessions({
        reset: true,
        ensureSessionId: data.nextSessionId ?? null,
      });
    } catch (error) {
      setChatStatus(resolveChatFetchErrorMessage(response, error, 'Failed to delete session'));
    } finally {
      setChatSessionActionPending(null);
    }
  }, [applyDeletedSessionLocally, chatSessionActionPending, conversationSessions.length, loadConversationSessions]);

  const setSessionCompactionState = useCallback((sessionId: string, phase: SessionCompactionPhase) => {
    setCompactingSessionIds((current) => ({
      ...current,
      [sessionId]: {
        phase,
        updatedAt: Date.now(),
      },
    }));
  }, []);

  const clearSessionCompactionState = useCallback((sessionId: string) => {
    setCompactingSessionIds((current) => {
      if (!current[sessionId]) {
        return current;
      }

      const next = { ...current };
      delete next[sessionId];
      return next;
    });
  }, []);

  const showCompactFeedback = useCallback((
    message: string,
    tone: CompactFeedbackState['tone'],
    sessionId: string | null = null,
  ) => {
    setCompactFeedback({
      id: Date.now(),
      tone,
      message,
      sessionId,
    });
  }, []);

  useEffect(() => {
    if (!compactFeedback) {
      return undefined;
    }

    const feedbackId = compactFeedback.id;
    const timeoutId = window.setTimeout(() => {
      setCompactFeedback((current) => (current?.id === feedbackId ? null : current));
    }, COMPACT_FEEDBACK_TIMEOUT_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [compactFeedback]);

  useEffect(() => {
    const entries = Object.entries(compactingSessionIds);
    if (entries.length === 0) {
      return undefined;
    }

    const now = Date.now();
    const nextExpiryMs = Math.min(...entries.map(([, state]) => (
      Math.max(0, state.updatedAt + CHAT_SESSION_COMPACTION_STALE_TIMEOUT_MS - now)
    )));
    const timeoutId = window.setTimeout(() => {
      const currentTime = Date.now();
      const expiredSessionIds = Object.entries(compactingSessionIds)
        .filter(([, state]) => isChatSessionCompactionStateStale(state, currentTime))
        .map(([sessionId]) => sessionId);

      if (expiredSessionIds.length === 0) {
        return;
      }

      setCompactingSessionIds((current) => {
        const next = { ...current };
        for (const sessionId of expiredSessionIds) {
          delete next[sessionId];
        }
        return next;
      });

      if (selectedSessionId && expiredSessionIds.includes(selectedSessionId)) {
        showCompactFeedback('Compact status timed out. You can try again.', 'error', selectedSessionId);
      }
    }, nextExpiryMs);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [compactingSessionIds, selectedSessionId, showCompactFeedback]);

  const compactSelectedChatSession = useCallback(async (session: ConversationSessionSummary | null) => {
    const sessionId = session?.sessionId ?? null;
    const existingState = sessionId ? compactingSessionIds[sessionId] : null;
    if (
      !session
      || !sessionId
      || (existingState && !isChatSessionCompactionStateStale(existingState))
    ) {
      return;
    }
    const unavailableReason = getChatSessionManualCompactionUnavailableReason(session.provider);
    if (unavailableReason) {
      setChatStatus(unavailableReason);
      showCompactFeedback(unavailableReason, 'error', sessionId);
      return;
    }

    setChatStatus(null);
    setCompactFeedback(null);
    setChatSessionMenuOpen(false);
    setChatSessionReasoningPopover(null);
    setSessionCompactionState(sessionId, 'running');

    try {
      const response = await fetch(`/api/chat/sessions/${encodeURIComponent(sessionId)}/compact`, {
        method: 'POST',
        cache: 'no-store',
      });
      const data = await response.json() as {
        error?: string;
        queued?: boolean;
        message?: string | null;
      };

      if (!response.ok) {
        throw new Error(data.error || `Error ${response.status}`);
      }

      if (data.queued) {
        setSessionCompactionState(sessionId, 'queued');
        showCompactFeedback(
          data.message || 'Compact queued. It will start when the current chat turn finishes.',
          'info',
          sessionId,
        );
      }
    } catch (error) {
      clearSessionCompactionState(sessionId);
      const message = error instanceof Error ? error.message : 'Failed to compact session';
      setChatStatus(message);
      showCompactFeedback(message, 'error', sessionId);
    }
  }, [clearSessionCompactionState, compactingSessionIds, setSessionCompactionState, showCompactFeedback]);

  const closeRenameSessionModal = useCallback(() => {
    if (isRenamingSession) return;
    setRenameSessionId(null);
    setRenameSessionTitle('');
    setRenameSessionError(null);
  }, [isRenamingSession]);

  const openRenameSessionModal = useCallback((session: ConversationSessionSummary | null) => {
    if (!session) return;

    setChatSessionMenuOpen(false);
    setChatSessionReasoningPopover(null);
    setChatSessionCompactPopover(null);
    setChatStatus(null);
    setRenameSessionId(session.sessionId);
    setRenameSessionTitle(session.title);
    setRenameSessionError(null);
  }, []);

  const toggleChatSessionReasoningPopover = useCallback((
    session: ConversationSessionSummary | null,
    anchor: 'menu' | 'badge',
  ) => {
    if (!session || (session.provider !== 'claude' && session.provider !== 'codex')) return;

    setChatStatus(null);
    setChatSessionCompactPopover(null);
    if (anchor === 'badge') {
      setChatSessionMenuOpen(false);
    }
    setChatSessionReasoningPopover((current) => (
      current?.sessionId === session.sessionId && current.anchor === anchor
        ? null
        : { sessionId: session.sessionId, anchor }
    ));
  }, []);

  const toggleChatSessionCompactPopover = useCallback((session: ConversationSessionSummary | null) => {
    if (!session || !canOpenChatSessionCompactPopover(session)) return;

    setChatStatus(null);
    setChatSessionMenuOpen(false);
    setChatSessionReasoningPopover(null);
    setChatSessionCompactPopover((current) => (
      current?.sessionId === session.sessionId
        ? null
        : { sessionId: session.sessionId }
    ));
  }, []);

  const updateClaudeSessionReasoningEffort = useCallback(async (
    session: ConversationSessionSummary | null,
    effort: ClaudeReasoningEffort,
  ) => {
    const sessionId = session?.sessionId ?? null;
    if (!sessionId || session?.provider !== 'claude' || chatSessionReasoningPendingSessionId) return;

    if (session.claudeReasoningEffort === effort) {
      setChatSessionReasoningPopover(null);
      return;
    }

    setChatSessionReasoningPendingSessionId(sessionId);
    setChatStatus(null);
    let response: Response | null = null;

    try {
      response = await fetch(`/api/chat/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ claudeReasoningEffort: effort }),
      });
      const data = await response.json() as {
        error?: string;
        session?: ConversationSessionSummary | null;
      };

      if (!response.ok) {
        throw new Error(resolveChatFetchErrorMessage(response, null, data.error || `Error ${response.status}`));
      }

      if (data.session) {
        setConversationSessions((current) => mergeConversationSessions(current, [data.session as ConversationSessionSummary]));
      } else {
        void refreshConversationSessionSummary(sessionId);
      }

      setChatSessionMenuOpen(false);
      setChatSessionReasoningPopover(null);
      setChatSessionCompactPopover(null);
    } catch (error) {
      setChatStatus(resolveChatFetchErrorMessage(response, error, 'Failed to update session reasoning'));
    } finally {
      setChatSessionReasoningPendingSessionId(null);
    }
  }, [chatSessionReasoningPendingSessionId, refreshConversationSessionSummary]);

  const updateCodexSessionSettings = useCallback(async (
    session: ConversationSessionSummary | null,
    updates: {
      codexReasoningEffort?: CodexReasoningEffort;
      codexFastMode?: boolean;
    },
  ) => {
    const sessionId = session?.sessionId ?? null;
    if (!sessionId || session?.provider !== 'codex' || chatSessionReasoningPendingSessionId) return;

    const body: {
      codexReasoningEffort?: CodexReasoningEffort;
      codexFastMode?: boolean;
    } = {};

    if (updates.codexReasoningEffort !== undefined && updates.codexReasoningEffort !== session.codexReasoningEffort) {
      body.codexReasoningEffort = updates.codexReasoningEffort;
    }
    if (updates.codexFastMode !== undefined && updates.codexFastMode !== session.codexFastMode) {
      body.codexFastMode = updates.codexFastMode;
    }

    if (!Object.keys(body).length) {
      setChatSessionReasoningPopover(null);
      return;
    }

    setChatSessionReasoningPendingSessionId(sessionId);
    setChatStatus(null);
    let response: Response | null = null;

    try {
      response = await fetch(`/api/chat/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify(body),
      });
      const data = await response.json() as {
        error?: string;
        session?: ConversationSessionSummary | null;
      };

      if (!response.ok) {
        throw new Error(resolveChatFetchErrorMessage(response, null, data.error || `Error ${response.status}`));
      }

      if (data.session) {
        setConversationSessions((current) => mergeConversationSessions(current, [data.session as ConversationSessionSummary]));
      } else {
        void refreshConversationSessionSummary(sessionId);
      }

      setChatSessionMenuOpen(false);
      setChatSessionReasoningPopover(null);
      setChatSessionCompactPopover(null);
    } catch (error) {
      setChatStatus(resolveChatFetchErrorMessage(response, error, 'Failed to update session settings'));
    } finally {
      setChatSessionReasoningPendingSessionId(null);
    }
  }, [chatSessionReasoningPendingSessionId, refreshConversationSessionSummary]);

  const handleRenameSessionTitleChange = useCallback((value: string) => {
    setRenameSessionTitle(value);
    if (renameSessionError) {
      setRenameSessionError(null);
    }
  }, [renameSessionError]);

  const renameSelectedChatSession = useCallback(async () => {
    const sessionId = renameSessionId?.trim() ? renameSessionId.trim() : null;
    const nextTitle = renameSessionTitle.trim();

    if (!sessionId || isRenamingSession) return;
    if (!nextTitle) {
      setRenameSessionError('Session name is required.');
      return;
    }

    setIsRenamingSession(true);
    setRenameSessionError(null);
    setChatStatus(null);
    let response: Response | null = null;

    try {
      response = await fetch(`/api/chat/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ title: nextTitle }),
      });
      const data = await response.json() as {
        error?: string;
        session?: ConversationSessionSummary | null;
      };

      if (!response.ok) {
        throw new Error(resolveChatFetchErrorMessage(response, null, data.error || `Error ${response.status}`));
      }

      if (data.session) {
        setConversationSessions((current) => mergeConversationSessions(current, [data.session as ConversationSessionSummary]));
      } else {
        void refreshConversationSessionSummary(sessionId);
      }

      setRenameSessionId(null);
      setRenameSessionTitle('');
      setRenameSessionError(null);
    } catch (error) {
      setRenameSessionError(resolveChatFetchErrorMessage(response, error, 'Failed to rename session'));
    } finally {
      setIsRenamingSession(false);
    }
  }, [isRenamingSession, refreshConversationSessionSummary, renameSessionId, renameSessionTitle]);

  const openPostDetail = useCallback((item: FeedItem) => {
    const nextId = item.id;
    if (!nextId) return;

    const currentStack = detailStackRef.current;
    if (currentStack.length === 0) {
      syncSelectedPostQueryParam(nextId, 'push');
      setDetailStack([{
        key: makeDetailEntryKey('post'),
        kind: 'post',
        routeId: nextId,
      }]);
      return;
    }

    const topEntry = currentStack[currentStack.length - 1];
    if (topEntry?.kind === 'post' && topEntry.routeId === nextId) {
      return;
    }

    setDetailStack((current) => [
      ...current,
      {
        key: makeDetailEntryKey('post'),
        kind: 'post',
        routeId: nextId,
      },
    ]);
  }, [makeDetailEntryKey, syncSelectedPostQueryParam]);

  const closeTopDetailView = useCallback(() => {
    if (detailStackRef.current.length > 1) {
      setDetailStack((current) => current.slice(0, -1));
      return;
    }

    const currentUrl = new URL(window.location.href);
    const hasPostParam = currentUrl.searchParams.has('post');
    const hasOverlayHistoryState = Boolean(window.history.state && typeof window.history.state === 'object' && 'evogentOverlayPost' in window.history.state);

    if (hasPostParam && hasOverlayHistoryState) {
      window.history.back();
      return;
    }

    syncSelectedPostQueryParam(null, 'replace');
    setDetailStack([]);
  }, [syncSelectedPostQueryParam]);

  const focusChatInput = useCallback((placeCaretAtEnd = false) => {
    const input = chatInputRef.current;
    if (!input) return false;

    input.focus({ preventScroll: true });
    if (placeCaretAtEnd) {
      moveCaretToEnd(input);
    }
    return true;
  }, []);

  const handleChatInputRef = useCallback((element: HTMLDivElement | null) => {
    chatInputRef.current = element;
    setChatInputElement(element);
  }, []);

  const applyChatCommand = useCallback((commandName: string) => {
    setChatInput((current) => buildSlashCommandComposerText(current, commandName));
    closeCommandPicker();
    window.requestAnimationFrame(() => {
      focusChatInput(true);
    });
  }, [closeCommandPicker, focusChatInput]);

  const handleResolvedDetailPostItem = useCallback((routeId: string, item: FeedItem | null) => {
    const normalizedRouteId = routeId.trim();
    if (!normalizedRouteId) return;

    if (item) {
      detailPostItemsRef.current.set(normalizedRouteId, item);
      return;
    }

    detailPostItemsRef.current.delete(normalizedRouteId);
  }, []);

  const resolveFeedItemById = useCallback((itemId: string | null | undefined): FeedItem | null => {
    const normalizedItemId = itemId?.trim();
    if (!normalizedItemId) return null;

    const loadedItem = itemsRef.current.find((entry) => entry.id === normalizedItemId)
      ?? pendingItemsRef.current.find((entry) => entry.id === normalizedItemId);
    if (loadedItem) {
      return loadedItem;
    }

    return detailPostItemsRef.current.get(normalizedItemId) ?? null;
  }, []);
  const loadBrainProviderStatus = useCallback(async () => {
    setIsLoadingBrainProviderStatus(true);
    setBrainProviderStatusError(null);

    try {
      const response = await fetch('/api/brain-provider', { cache: 'no-store' });
      const payload = await response.json() as BrainProviderStateResponse & { error?: string };

      if (!response.ok) {
        throw new Error(payload.error || `Error ${response.status}`);
      }

      setBrainProviderStatus(payload);
      setPendingBrainProvider(payload.currentProvider);
      setPendingCodexReasoningEffort(payload.codexReasoningEffort);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load provider status';
      setBrainProviderStatusError(message);
    } finally {
      setIsLoadingBrainProviderStatus(false);
    }
  }, []);

  const closeCreateSessionModal = useCallback(() => {
    if (isCreatingSession) return;
    setIsCreateSessionModalOpen(false);
    setNewSessionModalError(null);
  }, [isCreatingSession]);

  const openCreateSessionModal = useCallback(() => {
    setSessionPickerOpen(false);
    setChatStatus(null);
    setBrainProviderStatusError(null);
    setNewSessionProvider(brainProviderInfo.provider);
    setNewSessionClaudeReasoningEffort('high');
    setNewSessionCodexReasoningEffort(brainProviderInfo.codexReasoningEffort);
    setNewSessionCodexFastMode(false);
    setNewSessionType('normal');
    setNewSessionTitle(nextSessionDefaultTitle);
    setNewSessionColor(null);
    setNewSessionWorkingDirectory('');
    setNewSessionModalError(null);
    void loadBrainProviderStatus();
    window.setTimeout(() => {
      setIsCreateSessionModalOpen(true);
    }, 0);
  }, [brainProviderInfo.codexReasoningEffort, brainProviderInfo.provider, loadBrainProviderStatus, nextSessionDefaultTitle]);

  const openCuratorSessionCreateModal = useCallback(() => {
    setSessionPickerOpen(false);
    setChatStatus('Create a curator session before sending thread feedback.');
    setBrainProviderStatusError(null);
    setNewSessionProvider(brainProviderInfo.provider);
    setNewSessionClaudeReasoningEffort('high');
    setNewSessionCodexReasoningEffort(brainProviderInfo.codexReasoningEffort);
    setNewSessionCodexFastMode(false);
    setNewSessionType('curator');
    setNewSessionTitle('Main Curator');
    setNewSessionColor(null);
    setNewSessionWorkingDirectory('');
    setNewSessionModalError(null);
    void loadBrainProviderStatus();
    window.setTimeout(() => {
      setIsCreateSessionModalOpen(true);
    }, 0);
  }, [brainProviderInfo.codexReasoningEffort, brainProviderInfo.provider, loadBrainProviderStatus]);

  const createSession = useCallback(async ({
    body,
    composerPrefill,
    resetComposerContext = false,
  }: {
    body?: {
      title?: string | null;
      color?: string | null;
      provider?: BrainProviderName | null;
      sessionType?: ConversationSessionType;
      claudeReasoningEffort?: ClaudeReasoningEffort | null;
      codexReasoningEffort?: CodexReasoningEffort | null;
      codexFastMode?: boolean | null;
      workingDirectory?: string | null;
    };
    composerPrefill?: string | null;
    resetComposerContext?: boolean;
  } = {}): Promise<string | null> => {
    if (isCreatingSession) return null;

    setIsCreatingSession(true);
    setNewSessionModalError(null);
    setChatStatus(null);

    try {
      const response = await fetch('/api/chat/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      const data = await response.json() as {
        error?: string;
        session?: ConversationSessionSummary & { id?: string; sessionId?: string };
        sessions?: ConversationSessionSummary[];
      };

      const createdSessionId = typeof data.session?.id === 'string' && data.session.id
        ? data.session.id
        : (typeof data.session?.sessionId === 'string' && data.session.sessionId ? data.session.sessionId : null);

      if (!response.ok || !createdSessionId) {
        throw new Error(data.error || `Error ${response.status}`);
      }

      hydratedConversationSessionIdsRef.current.delete(createdSessionId);
      void loadConversationSessions({ reset: true, ensureSessionId: createdSessionId });
      updateSelectedChatSession(createdSessionId);
      setConversationHighlightId(createdSessionId);
      setConversationScrollToBottomId(createdSessionId);
      if (isChatDetailOpen) {
        openConversationDetail(createdSessionId, null, { replaceTop: true });
      }
      if (composerPrefill != null) {
        setChatInput(composerPrefill);
      }
      if (resetComposerContext) {
        setChatContext(null);
        setChatAttachments([]);
        setChatPostContext(null);
        setChatSelectedText(null);
      }
      setIsCreateSessionModalOpen(false);
      window.requestAnimationFrame(() => {
        focusChatInput(true);
      });
      return createdSessionId;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create session';
      setNewSessionModalError(message);
      setChatStatus(message);
      return null;
    } finally {
      setIsCreatingSession(false);
    }
  }, [
    focusChatInput,
    isChatDetailOpen,
    isCreatingSession,
    loadConversationSessions,
    openConversationDetail,
    updateSelectedChatSession,
  ]);

  const createSessionFromModal = useCallback(async () => {
    await createSession({
      body: {
        title: newSessionTitle,
        color: newSessionColor,
        provider: newSessionProvider,
        sessionType: newSessionType === 'curator' ? 'curator' : null,
        claudeReasoningEffort: newSessionProvider === 'claude'
          ? newSessionClaudeReasoningEffort
          : null,
        codexReasoningEffort: newSessionProvider === 'codex'
          ? newSessionCodexReasoningEffort
          : null,
        codexFastMode: newSessionProvider === 'codex' ? newSessionCodexFastMode : null,
        workingDirectory: newSessionWorkingDirectory,
      },
    });
  }, [
    createSession,
    newSessionClaudeReasoningEffort,
    newSessionCodexFastMode,
    newSessionCodexReasoningEffort,
    newSessionColor,
    newSessionProvider,
    newSessionType,
    newSessionTitle,
    newSessionWorkingDirectory,
  ]);

  const createSessionForAgentSetup = useCallback(() => {
    const sessionTitle = newSessionTitle.trim() || nextSessionDefaultTitle;
    const sessionColor = newSessionColor?.trim() ?? '';
    const sessionWorkingDirectory = newSessionWorkingDirectory.trim();
    const newSessionProviderLabel = getProviderDisplayName(newSessionProvider);
    const colorPhrase = sessionColor ? ` with a ${sessionColor} theme` : '';
    const projectContextPhrase = sessionWorkingDirectory ? `for working in ${sessionWorkingDirectory}` : 'for working on Evogent project';

    closeCreateSessionModal();
    setChatInput(`/new-chat-session Start a new ${newSessionProviderLabel} session called ${JSON.stringify(sessionTitle)}${colorPhrase} ${projectContextPhrase}.`);
    window.requestAnimationFrame(() => {
      focusChatInput(true);
    });
  }, [
    closeCreateSessionModal,
    focusChatInput,
    newSessionColor,
    newSessionProvider,
    newSessionTitle,
    newSessionWorkingDirectory,
    nextSessionDefaultTitle,
  ]);

  const closeBrainProviderModal = useCallback(() => {
    if (isSwitchingBrainProvider) {
      return;
    }

    setIsBrainProviderModalOpen(false);
    setBrainProviderStatusError(null);
  }, [isSwitchingBrainProvider]);

  const closeUsageModal = useCallback(() => {
    setIsUsageModalOpen(false);
  }, []);

  const openBrainProviderModal = useCallback(() => {
    setIsMobileMenuOpen(false);
    setSessionPickerOpen(false);
    setCommandPickerOpen(false);
    setChatSessionMenuOpen(false);
    setBrainProviderStatusError(null);
    setPendingBrainProvider(brainProviderInfo.provider);
    setPendingCodexReasoningEffort(brainProviderInfo.codexReasoningEffort);
    setIsBrainProviderModalOpen(true);
    void loadBrainProviderStatus();
  }, [
    brainProviderInfo.codexReasoningEffort,
    brainProviderInfo.provider,
    loadBrainProviderStatus,
  ]);

  const openUsageModal = useCallback(() => {
    setIsMobileMenuOpen(false);
    setSessionPickerOpen(false);
    setCommandPickerOpen(false);
    setChatSessionMenuOpen(false);
    setIsUsageModalOpen(true);
  }, []);

  const submitBrainProviderSwitch = useCallback(async () => {
    if (isSwitchingBrainProvider) {
      return;
    }

    setIsSwitchingBrainProvider(true);
    setBrainProviderStatusError(null);
    setChatStatus(null);

    try {
      const response = await fetch('/api/brain-provider', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: pendingBrainProvider,
          codexReasoningEffort: pendingCodexReasoningEffort,
        }),
      });

      const payload = await response.json() as (BrainProviderStateResponse & {
        error?: string;
        content?: string;
        sessionId?: string | null;
        sessions?: ConversationSessionSummary[];
      });

      if (!response.ok || typeof payload.content !== 'string' || !payload.sessionId) {
        throw new Error(payload.error || `Error ${response.status}`);
      }

      setBrainProviderStatus(payload);
      setConfigContent(payload.content);
      hydratedConversationSessionIdsRef.current.delete(payload.sessionId);
      void loadConversationSessions({ reset: true, ensureSessionId: payload.sessionId });
      updateSelectedChatSession(payload.sessionId, { pauseAutoCorrection: false });
      setConversationHighlightId(payload.sessionId);
      setConversationScrollToBottomId(payload.sessionId);
      if (isChatDetailOpen) {
        openConversationDetail(payload.sessionId, null, { replaceTop: true });
      }
      setStreamingChat(null);
      setChatProgress(null);
      setBrainTyping(false);
      setLastChatActivityAt(null);
      setChatCommands([]);
      setChatCommandsStatus('idle');
      setChatCommandsError(null);
      setCommandPickerOpen(false);
      setBrainProviderStatusError(null);
      setIsBrainProviderModalOpen(false);
      void loadChatCommands();
      window.requestAnimationFrame(() => {
        focusChatInput(true);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to switch provider';
      setBrainProviderStatusError(message);
      setChatStatus(message);
    } finally {
      setIsSwitchingBrainProvider(false);
    }
  }, [
    focusChatInput,
    isChatDetailOpen,
    isSwitchingBrainProvider,
    loadChatCommands,
    loadConversationSessions,
    openConversationDetail,
    pendingBrainProvider,
    pendingCodexReasoningEffort,
    updateSelectedChatSession,
  ]);

  const submitCurateToSession = useCallback(async (
    sessionId: string,
    command: CurateCommand = '/curate',
    options?: { openDetailOnSuccess?: boolean; originView?: string; selectOnSuccess?: boolean },
  ): Promise<boolean> => {
    const openDetailOnSuccess = options?.openDetailOnSuccess ?? true;
    const selectOnSuccess = options?.selectOnSuccess ?? true;
    let response: Response | null = null;
    try {
      setChatStatus(null);
      response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: command,
          sessionId,
          context: null,
          inReplyTo: null,
          contextKind: 'global',
          contextRefId: null,
          originView: options?.originView ?? (hasOpenDetailView ? 'post_detail' : 'feed'),
        }),
      });
      if (isAuthFailure(response, null)) {
        throw new Error(resolveChatFetchErrorMessage(response, null, 'Unable to start curation in this session'));
      }
      const data = (await response.json()) as {
        ok?: boolean;
        message?: string;
        userMessage?: ChatMessage;
        sessionId?: string | null;
      };
      if (data.userMessage) {
        setChatMessages((current) => mergeChatMessages(current, [data.userMessage as ChatMessage]));
      }
      if (!response.ok || !data.ok) {
        throw new Error(data.message || 'Unable to start curation in this session');
      }
      if (data.sessionId) {
        hydratedConversationSessionIdsRef.current.delete(data.sessionId);
        void refreshConversationSessionSummary(data.sessionId);
        if (selectOnSuccess) {
          updateSelectedChatSession(data.sessionId);
          setConversationHighlightId(data.sessionId);
          setConversationScrollToBottomId(data.sessionId);
          if (openDetailOnSuccess) {
            openConversationDetail(data.sessionId, null, { replaceTop: true });
          }
        }
      }
      return true;
    } catch (error) {
      setChatStatus(resolveChatFetchErrorMessage(response, error, 'Failed to start curator session curation'));
      return false;
    } finally {
      setSessionPickerOpen(false);
    }
  }, [hasOpenDetailView, openConversationDetail, refreshConversationSessionSummary, updateSelectedChatSession]);

  const submitGeneralChatCommand = useCallback(async ({
    command,
    resolveSessionId,
    originView,
    triggerSource,
    missingSessionMessage,
    submitMessage,
    fallbackMessage,
    closeMobileMenu = false,
  }: {
    command: string;
    resolveSessionId: () => string | null;
    originView: typeof SETUP_WIZARD_ORIGIN_VIEW | typeof SOURCE_HEALTH_ORIGIN_VIEW;
    triggerSource: string;
    missingSessionMessage: string;
    submitMessage: string;
    fallbackMessage: string;
    closeMobileMenu?: boolean;
  }) => {
    setChatStatus(null);
    streamingSupersededRef.current = false;
    setBrainTyping(true);
    setChatProgress(null);
    setStreamingChat(null);
    setLastChatActivityAt(null);

    try {
      let sessionId = resolveSessionId();

      if (!sessionId) {
        sessionId = await createSession({
          body: {
            title: DEFAULT_GENERAL_AGENT_SESSION_TITLE,
            sessionType: null,
          },
          resetComposerContext: true,
        });
      }

      if (!sessionId) {
        throw new Error(missingSessionMessage);
      }

      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: command,
          sessionId,
          context: null,
          inReplyTo: null,
          contextKind: 'global',
          contextRefId: null,
          originView,
          metadata: {
            triggerSource,
          },
        }),
      });

      const data = (await response.json()) as {
        ok?: boolean;
        message?: string;
        userMessage?: ChatMessage;
        sessionId?: string | null;
      };

      if (data.userMessage) {
        setChatMessages((current) => mergeChatMessages(current, [data.userMessage as ChatMessage]));
      }

      if (!response.ok || !data.ok) {
        throw new Error(data.message || submitMessage);
      }

      if (data.sessionId) {
        hydratedConversationSessionIdsRef.current.delete(data.sessionId);
        void refreshConversationSessionSummary(data.sessionId);
        updateSelectedChatSession(data.sessionId);
        setConversationHighlightId(data.sessionId);
        setConversationScrollToBottomId(data.sessionId);
        openConversationDetail(data.sessionId, null, {
          replaceTop: true,
        });
      }

      setChatInput('');
      setChatContext(null);
      setChatAttachments([]);
      setChatPostContext(null);
      setChatSelectedText(null);
      if (closeMobileMenu) {
        setIsMobileMenuOpen(false);
      }
    } catch (error) {
      setBrainTyping(false);
      setChatProgress(null);
      setChatStatus(error instanceof Error ? error.message : fallbackMessage);
    }
  }, [
    createSession,
    openConversationDetail,
    refreshConversationSessionSummary,
    updateSelectedChatSession,
  ]);

  const submitSetupWizardFromBanner = useCallback(async () => {
    if (isStartingSetupWizard || isSendingChat || isUploadingChatAttachments) return;

    setIsStartingSetupWizard(true);
    try {
      await submitGeneralChatCommand({
        command: SETUP_WIZARD_COMMAND,
        resolveSessionId: () => resolveSetupWizardSessionId(
          conversationSessionsRef.current,
          selectedSessionIdRef.current,
        ),
        originView: SETUP_WIZARD_ORIGIN_VIEW,
        triggerSource: 'setup_card',
        missingSessionMessage: 'Unable to find or create a setup chat session',
        submitMessage: 'Unable to start setup chat',
        fallbackMessage: 'Failed to start setup chat',
      });
    } finally {
      setIsStartingSetupWizard(false);
    }
  }, [
    isSendingChat,
    isStartingSetupWizard,
    isUploadingChatAttachments,
    submitGeneralChatCommand,
  ]);

  const submitSourceHealthFromSidebar = useCallback(async () => {
    if (isStartingSourceHealth || isSendingChat || isUploadingChatAttachments) return;

    setIsStartingSourceHealth(true);
    try {
      await submitGeneralChatCommand({
        command: SOURCE_STATUS_COMMAND,
        resolveSessionId: () => resolveSourceHealthSessionId(
          conversationSessionsRef.current,
          selectedSessionIdRef.current,
        ),
        originView: SOURCE_HEALTH_ORIGIN_VIEW,
        triggerSource: SOURCE_HEALTH_TRIGGER_SOURCE,
        missingSessionMessage: 'Unable to find or create a source health chat session',
        submitMessage: 'Unable to start source health chat',
        fallbackMessage: 'Failed to start source health chat',
        closeMobileMenu: true,
      });
    } finally {
      setIsStartingSourceHealth(false);
    }
  }, [
    isSendingChat,
    isStartingSourceHealth,
    isUploadingChatAttachments,
    submitGeneralChatCommand,
  ]);

  const selectSessionFromPicker = useCallback((sessionId: string) => {
    updateSelectedChatSession(sessionId);
    if (isChatDetailOpen) {
      const conversation = conversationCardMap[sessionId] ?? null;
      openConversationDetail(
        sessionId,
        conversation?.contextKind === 'post' ? conversation.contextRefId : null,
        { replaceTop: true },
      );
    }
    setSessionPickerOpen(false);
    focusChatInput(true);
  }, [
    conversationCardMap,
    focusChatInput,
    isChatDetailOpen,
    openConversationDetail,
    updateSelectedChatSession,
  ]);

  const prepareChatAboutPost = useCallback((item: FeedItem, selectedText?: string) => {
    const trimmedSelectedText = selectedText?.trim() ? selectedText.trim() : null;
    const linkedConversation = conversationCards.find((conversation) => (
      conversation.contextKind === 'post' && conversation.contextRefId === item.id
    )) ?? null;

    setChatPostContext(item);
    setChatSelectedText(trimmedSelectedText);
    if (linkedConversation) {
      // Resume existing conversation about this post
      updateSelectedChatSession(linkedConversation.sessionId);
      setConversationScrollToBottomId(linkedConversation.sessionId);
    }
    if (trimmedSelectedText) {
      setChatInput(`Discuss this excerpt:\n"${trimmedSelectedText}"\n\n`);
    }
    return linkedConversation;
  }, [conversationCards, updateSelectedChatSession]);

  const handleChatAboutPost = useCallback((item: FeedItem, selectedText?: string) => {
    prepareChatAboutPost(item, selectedText);
    focusChatInput(true);
  }, [focusChatInput, prepareChatAboutPost]);

  const handleChatAboutPostInDetail = useCallback((item: FeedItem, selectedText?: string) => {
    prepareChatAboutPost(item, selectedText);
    focusChatInput(true);
  }, [focusChatInput, prepareChatAboutPost]);

  const handleChatAboutSuggestion = useCallback((item: FeedItem) => {
    const destination = resolveSuggestionChatDestination({
      items: [item],
      conversationSessions,
      targetSessionId,
    });
    const payload = destination.mode === 'fallback'
      ? applySuggestionChatFallbackReason(
        getSuggestionChatContext(item, resolveSuggestionStatus(item)),
        destination.reason,
      )
      : getSuggestionChatContext(item, resolveSuggestionStatus(item));

    setChatPostContext(null);
    setChatSelectedText(null);
    setChatContext(payload.context);
    setChatInput(payload.message);
    if (destination.mode === 'origin') {
      updateSelectedChatSession(destination.sessionId);
      setConversationScrollToBottomId(destination.sessionId);
      openConversationDetail(destination.sessionId, null);
    } else {
      openConversationDetail(destination.sessionId, null);
    }
    focusChatInput(true);
  }, [conversationSessions, focusChatInput, openConversationDetail, resolveSuggestionStatus, targetSessionId, updateSelectedChatSession]);

  const handleChatAboutSuggestionGroup = useCallback((groupItems: FeedItem[]) => {
    const payload = getGroupedCodeFixSuggestionChatContext(groupItems, resolveSuggestionStatus);
    if (!payload) {
      return;
    }
    const destination = resolveSuggestionChatDestination({
      items: groupItems,
      conversationSessions,
      targetSessionId,
    });
    const chatPayload = destination.mode === 'fallback'
      ? applySuggestionChatFallbackReason(payload, destination.reason)
      : payload;

    setChatPostContext(null);
    setChatSelectedText(null);
    setChatContext(chatPayload.context);
    setChatInput(chatPayload.message);
    if (destination.mode === 'origin') {
      updateSelectedChatSession(destination.sessionId);
      setConversationScrollToBottomId(destination.sessionId);
      openConversationDetail(destination.sessionId, null);
    } else {
      openConversationDetail(destination.sessionId, null);
    }
    focusChatInput(true);
  }, [conversationSessions, focusChatInput, openConversationDetail, resolveSuggestionStatus, targetSessionId, updateSelectedChatSession]);

  const loadTaskTranscriptFallback = useCallback(async (
    taskId: string,
    logFile: string | null,
    markLoading: boolean,
  ) => {
    if (!taskId) return;

    if (markLoading) {
      setTaskTranscriptFallbacks((current) => ({
        ...current,
        [taskId]: {
          loading: true,
          error: null,
          text: current[taskId]?.text ?? null,
          source: current[taskId]?.source ?? null,
        },
      }));
    }

    try {
      if (logFile) {
        const response = await fetch(`/api/agents/transcript?file=${encodeURIComponent(logFile)}`, { cache: 'no-store' });
        if (response.ok) {
          const data = (await response.json()) as { transcript?: string | null };
          setTaskTranscriptFallbacks((current) => ({
            ...current,
            [taskId]: {
              loading: false,
              error: null,
              text: typeof data.transcript === 'string' ? data.transcript : '',
              source: 'log_file',
            },
          }));
          return;
        }
      }

      const response = await fetch(`/api/orchestrator/history/${encodeURIComponent(taskId)}`, { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`Error ${response.status}`);
      }

      const data = (await response.json()) as { response?: string | null };
      setTaskTranscriptFallbacks((current) => ({
        ...current,
        [taskId]: {
          loading: false,
          error: null,
          text: typeof data.response === 'string' ? data.response : '',
          source: 'history',
        },
      }));
    } catch {
      setTaskTranscriptFallbacks((current) => {
        const previous = current[taskId];
        const hasPreviousTranscript = Boolean(previous?.text);
        return {
          ...current,
          [taskId]: {
            loading: false,
            error: hasPreviousTranscript ? null : 'Failed to load transcript.',
            text: previous?.text ?? null,
            source: previous?.source ?? null,
          },
        };
      });
    }
  }, []);

  useEffect(() => {
    if (!hasLoadedSearchQuery) return;
    fetchFeed(true);
  }, [fetchFeed, hasLoadedSearchQuery]);

  useEffect(() => {
    void loadConversationSessions({ reset: true, ensureSessionId: selectedSessionIdRef.current });
    void loadRecentChatMessages();
  }, [loadConversationSessions, loadRecentChatMessages]);

  const feedWsHandlersRef = useRef<{
    applyIncomingFeedItems: typeof applyIncomingFeedItems;
    hasActiveSearch: boolean;
    syncRecentFeedItems: typeof syncRecentFeedItems;
  } | null>(null);

  useLayoutEffect(() => {
    feedWsHandlersRef.current = {
      applyIncomingFeedItems,
      hasActiveSearch,
      syncRecentFeedItems,
    };
  }, [applyIncomingFeedItems, hasActiveSearch, syncRecentFeedItems]);

  const chatWsHandlersRef = useRef<{
    applyDeletedSessionLocally: typeof applyDeletedSessionLocally;
    applyResetSessionLocally: typeof applyResetSessionLocally;
    clearDeliveredAgentChatState: typeof clearDeliveredAgentChatState;
    loadConversationSessions: typeof loadConversationSessions;
    loadRecentChatMessages: typeof loadRecentChatMessages;
    markChatActivity: typeof markChatActivity;
    rememberLiveActivity: typeof rememberLiveActivity;
    refreshConversationSessionSummary: typeof refreshConversationSessionSummary;
    scheduleConversationRefresh: typeof scheduleConversationRefresh;
  } | null>(null);

  useLayoutEffect(() => {
    chatWsHandlersRef.current = {
      applyDeletedSessionLocally,
      applyResetSessionLocally,
      clearDeliveredAgentChatState,
      loadConversationSessions,
      loadRecentChatMessages,
      markChatActivity,
      rememberLiveActivity,
      refreshConversationSessionSummary,
      scheduleConversationRefresh,
    };
  }, [
    applyDeletedSessionLocally,
    applyResetSessionLocally,
    clearDeliveredAgentChatState,
    loadConversationSessions,
    loadRecentChatMessages,
    markChatActivity,
    rememberLiveActivity,
    refreshConversationSessionSummary,
    scheduleConversationRefresh,
  ]);

  useEffect(() => () => {
    if (conversationRefreshTimerRef.current !== null) {
      window.clearTimeout(conversationRefreshTimerRef.current);
      conversationRefreshTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const chatAboutId = query.get('chatAbout');
    if (!chatAboutId) return;
    const selectedText = query.get('chatSelection')?.trim() || null;
    setPendingChatAboutRequest({
      itemId: chatAboutId,
      selectedText,
    });
  }, []);

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const postId = query.get('post');
    if (postId) {
      setDetailStack([{
        key: makeDetailEntryKey('post'),
        kind: 'post',
        routeId: postId,
      }]);
    }
  }, [makeDetailEntryKey]);

  useEffect(() => {
    const handlePopState = () => {
      const query = new URLSearchParams(window.location.search);
      const nextPostId = query.get('post');
      const nextSearchQuery = normalizeFeedSearchQuery(query.get('q'));

      setSearchDraft(nextSearchQuery);
      setSearchQuery(nextSearchQuery || null);

      if (!nextPostId) {
        setDetailStack([]);
        return;
      }

      setDetailStack((current) => {
        const remainingStack = current.filter((entry) => entry.kind !== 'post');
        return [{
          key: makeDetailEntryKey('post'),
          kind: 'post',
          routeId: nextPostId,
        }, ...remainingStack];
      });
    };

    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, [makeDetailEntryKey]);

  useEffect(() => {
    if (!pendingChatAboutRequest) return;

    let cancelled = false;
    const openChatAboutPost = async () => {
      const localMatch = itemsRef.current.find((entry) => entry.id === pendingChatAboutRequest.itemId);
      if (localMatch) {
        if (cancelled) return;
        handleChatAboutPost(localMatch, pendingChatAboutRequest.selectedText ?? undefined);
        setPendingChatAboutRequest(null);
        clearChatAboutQueryParam();
        return;
      }

      try {
        const response = await fetch(`/api/feed/${encodeURIComponent(pendingChatAboutRequest.itemId)}`, {
          cache: 'no-store',
        });
        if (!response.ok) {
          throw new Error(`Error ${response.status}`);
        }

        const payload = (await response.json()) as { item?: FeedItem };
        if (cancelled) return;

        const matchedItem = payload.item;
        if (matchedItem) {
          setItems((current) => Array.from(normalizeFeedItems([matchedItem, ...current]).values()));
          handleChatAboutPost(matchedItem, pendingChatAboutRequest.selectedText ?? undefined);
        }
      } catch {
        // ignore invalid query IDs
      } finally {
        if (!cancelled) {
          setPendingChatAboutRequest(null);
          clearChatAboutQueryParam();
        }
      }
    };

    void openChatAboutPost();

    return () => {
      cancelled = true;
    };
  }, [clearChatAboutQueryParam, handleChatAboutPost, pendingChatAboutRequest]);

  useEffect(() => {
    let cancelled = false;

    const loadConfig = async () => {
      try {
        const response = await fetch('/api/config', { cache: 'no-store' });
        if (!response.ok) throw new Error(`Error ${response.status}`);
        const payload = (await response.json()) as { content?: string };
        if (cancelled) return;
        if (typeof payload.content === 'string') {
          setConfigContent(payload.content);
        }
      } catch {
        if (!cancelled) {
          setConfigContent(null);
        }
      }
    };

    void loadConfig();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    void postActivity('app_open', {
      path: window.location.pathname,
      userAgent: navigator.userAgent,
    });

    const onVisibilityChange = () => {
      const event: ActivityEvent = document.visibilityState === 'visible' ? 'foreground' : 'background';
      void postActivity(event, {
        path: window.location.pathname,
        visibilityState: document.visibilityState,
      });
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [postActivity]);

  useEffect(() => {
    const dispose = createReconnectingWs(createWsUrl('/ws/feed'), (event) => {
      const handlers = feedWsHandlersRef.current;
      if (!handlers) {
        return;
      }
      try {
        const payload = JSON.parse(event.data) as { type?: string; items?: FeedItem[] };
        if (payload.type !== 'feed_update' || !Array.isArray(payload.items) || payload.items.length === 0) {
          return;
        }
        if (handlers.hasActiveSearch) {
          void handlers.syncRecentFeedItems();
          return;
        }
        handlers.applyIncomingFeedItems(payload.items);
      } catch {
        // ignore malformed messages
      }
    }, {
      onReconnect: () => {
        const handlers = feedWsHandlersRef.current;
        if (!handlers) {
          return;
        }
        // Treat reconnect catch-up like a batch of live updates so the
        // visible feed stays stable and new posts use the existing banner UX.
        void handlers.syncRecentFeedItems();
      },
    });

    return dispose;
  }, []);

  useEffect(() => {
    const dispose = createReconnectingWs(createWsUrl('/ws/chat'), (event) => {
      const handlers = chatWsHandlersRef.current;
      if (!handlers) {
        return;
      }
      try {
        const payload = JSON.parse(event.data) as {
          type?: string;
          items?: ChatMessage[];
          item?: ChatMessage;
          suggestion?: {
            id?: string;
            title?: string;
            summary?: string;
            suggestionType?: string;
            proposedValue?: string;
            status?: string;
          };
          text?: string;
          activity?: string;
          tool?: string;
          inReplyTo?: string | null;
          typing?: boolean;
          ts?: string;
          error?: string;
          originSessionId?: string | null;
          sessionId?: string | null;
          nextSessionId?: string | null;
        };
        if (payload.type === 'chat_typing' && typeof payload.typing === 'boolean') {
          if (
            payload.typing
            && shouldIgnoreSupersededLiveUpdate(
              chatMessagesRef.current,
              null,
              streamingSupersededRef.current,
            )
          ) {
            return;
          }
          setBrainTyping(payload.typing);
          if (!payload.typing) {
            setChatProgress(null);
          }
          return;
        }

        if (payload.type === 'chat_progress' && typeof payload.activity === 'string' && payload.activity.trim()) {
          const inReplyTo = typeof payload.inReplyTo === 'string' && payload.inReplyTo ? payload.inReplyTo : null;
          if (
            shouldIgnoreSupersededLiveUpdate(
              chatMessagesRef.current,
              inReplyTo,
              streamingSupersededRef.current,
            )
          ) {
            return;
          }
          handlers.markChatActivity();
          const toolName = typeof payload.tool === 'string' && payload.tool.trim() ? payload.tool.trim() : 'Working';
          const activityText = payload.activity.trim();
          const sessionId = typeof payload.sessionId === 'string' && payload.sessionId.trim()
            ? payload.sessionId.trim()
            : resolveChatSessionIdFromInReplyTo(chatMessagesRef.current, inReplyTo);
          handlers.rememberLiveActivity(sessionId, {
            label: 'Tool activity',
            detail: activityText,
            badge: toolName,
            status: 'running',
          });
          setChatProgress({
            activity: activityText,
            tool: toolName,
            inReplyTo,
            sessionId,
          });
          return;
        }

        if (payload.type === 'chat_streaming') {
          const text = typeof payload.text === 'string' ? payload.text : '';
          const inReplyTo = typeof payload.inReplyTo === 'string' && payload.inReplyTo ? payload.inReplyTo : null;
          if (
            shouldIgnoreSupersededLiveUpdate(
              chatMessagesRef.current,
              inReplyTo,
              streamingSupersededRef.current,
            )
          ) {
            return;
          }
          handlers.markChatActivity();
          const sessionId = typeof payload.sessionId === 'string' && payload.sessionId.trim()
            ? payload.sessionId.trim()
            : resolveChatSessionIdFromInReplyTo(chatMessagesRef.current, inReplyTo);
          if (!text) {
            setChatProgress(null);
          } else {
            handlers.rememberLiveActivity(sessionId, {
              label: 'Streaming reply',
              detail: getStreamingPreviewLine(text),
              badge: 'Live',
              status: 'running',
            });
          }
          setStreamingChat(text ? { text, inReplyTo, sessionId } : null);
          return;
        }

        if (payload.type === 'chat_session_reset' && typeof payload.sessionId === 'string' && payload.sessionId) {
          handlers.applyResetSessionLocally(payload.sessionId);
          void handlers.loadConversationSessions({ reset: true, ensureSessionId: payload.sessionId });
          return;
        }

        if (payload.type === 'chat_session_created' && typeof payload.sessionId === 'string' && payload.sessionId) {
          void handlers.loadConversationSessions({ reset: true });
          return;
        }

        if (payload.type === 'chat_session_deleted' && typeof payload.sessionId === 'string' && payload.sessionId) {
          const nextSessions = conversationSessionsRef.current.filter((session) => session.sessionId !== payload.sessionId);
          handlers.applyDeletedSessionLocally(
            payload.sessionId,
            typeof payload.nextSessionId === 'string' && payload.nextSessionId ? payload.nextSessionId : nextSessions[0]?.sessionId ?? null,
            nextSessions,
          );
          void handlers.loadConversationSessions({
            reset: true,
            ensureSessionId: typeof payload.nextSessionId === 'string' && payload.nextSessionId ? payload.nextSessionId : null,
          });
          return;
        }

        if (payload.type === 'chat_session_updated' && typeof payload.sessionId === 'string' && payload.sessionId) {
          void handlers.refreshConversationSessionSummary(payload.sessionId);
          return;
        }

        if (payload.type === 'chat_session_compacting' && typeof payload.sessionId === 'string' && payload.sessionId) {
          const compactingSessionId = payload.sessionId.trim();
          setCompactingSessionIds((current) => ({
            ...current,
            [compactingSessionId]: {
              phase: 'running',
              updatedAt: Date.now(),
            },
          }));
          return;
        }

        if (
          (payload.type === 'chat_session_compacted' || payload.type === 'chat_session_compact_failed')
          && typeof payload.sessionId === 'string'
          && payload.sessionId
        ) {
          const compactedSessionId = payload.sessionId.trim();
          clearSessionCompactionState(compactedSessionId);
          void handlers.refreshConversationSessionSummary(compactedSessionId);
          if (payload.type === 'chat_session_compact_failed' && typeof payload.error === 'string' && payload.error.trim()) {
            const message = payload.error.trim();
            setChatStatus(message);
            showCompactFeedback(message, 'error', compactedSessionId);
          }
          return;
        }

        if (payload.type === 'chat_suggestion') {
          const originSessionId = typeof payload.originSessionId === 'string' && payload.originSessionId.trim()
            ? payload.originSessionId.trim()
            : typeof payload.sessionId === 'string' && payload.sessionId.trim()
              ? payload.sessionId.trim()
            : null;
          const suggestion = payload.suggestion;
          const title = typeof suggestion?.title === 'string' ? suggestion.title.trim() : '';
          const summary = typeof suggestion?.summary === 'string' ? suggestion.summary.trim() : '';
          const proposedValue = typeof suggestion?.proposedValue === 'string' ? suggestion.proposedValue.trim() : '';
          const suggestionId = typeof suggestion?.id === 'string' ? suggestion.id.trim() : '';
          const suggestionType = typeof suggestion?.suggestionType === 'string'
            ? suggestion.suggestionType.trim().toLowerCase()
            : '';
          const status = typeof suggestion?.status === 'string' ? suggestion.status.trim().toLowerCase() : 'pending';

          if (originSessionId && suggestionId && title && summary && proposedValue && suggestionType === 'code_fix') {
            const inlineSuggestion: InlineCodeFixChatSuggestion = {
              id: suggestionId,
              title,
              summary,
              suggestionType: 'code_fix',
              proposedValue,
              status: status === 'accepted'
                || status === 'dismissed'
                || status === 'dispatched'
                || status === 'running'
                || status === 'merged'
                || status === 'failed'
                ? status
                : 'pending',
            };
            setChatMessages((current) => mergeChatMessages(current, [
              buildInlineCodeFixChatMessage({
                originSessionId,
                suggestion: inlineSuggestion,
                timestamp: typeof payload.ts === 'string' && payload.ts ? payload.ts : undefined,
              }),
            ]));
            handlers.scheduleConversationRefresh();
          }
          return;
        }

        const incoming = payload.type === 'chat_reply' && payload.item
          ? [payload.item]
          : Array.isArray(payload.items)
            ? payload.items
            : null;
        if (
          (payload.type !== 'chat_update' && payload.type !== 'chat_reply')
          || !incoming
          || incoming.length === 0
        ) {
          return;
        }
        const curationEvents = incoming
          .map((message) => ({ message, metadata: getAgentEventMetadata(message) }))
          .filter(({ metadata }) => metadata && typeof metadata.event === 'string' && metadata.event.startsWith('curation_'))
          .map(({ message, metadata }) => ({
            id: message.id,
            text: message.text,
            timestamp: message.timestamp,
            event: metadata?.event ?? null,
            status: metadata?.status ?? null,
            taskId: metadata?.taskId ?? null,
            logFile: metadata?.logFile ?? null,
            hasTranscript: metadata?.hasTranscript ?? false,
          }));
        if (curationEvents.length > 0) {
          console.log('[chat] received curation agent events', curationEvents);
        }

        handlers.clearDeliveredAgentChatState(incoming);

        setChatMessages((current) => mergeChatMessages(current, incoming));
        const sessionIdsToRefresh = new Set<string>();
        for (const item of incoming) {
          const sessionId = typeof item.sessionId === 'string' && item.sessionId.trim()
            ? item.sessionId.trim()
            : resolveChatSessionIdFromInReplyTo(chatMessagesRef.current, item.inReplyTo);
          if (sessionId) {
            sessionIdsToRefresh.add(sessionId);
          }
        }
        for (const sessionId of sessionIdsToRefresh) {
          void handlers.refreshConversationSessionSummary(sessionId);
        }
        handlers.scheduleConversationRefresh();
      } catch {
        // ignore malformed messages
      }
    }, {
      onReconnect: () => {
        const handlers = chatWsHandlersRef.current;
        if (!handlers) {
          return;
        }
        void handlers.loadConversationSessions({ reset: true, ensureSessionId: selectedSessionIdRef.current });
        void handlers.loadRecentChatMessages();
      },
    });

    return dispose;
  }, [clearSessionCompactionState, showCompactFeedback]);

  useEffect(() => {
    const dispose = createReconnectingWs(createWsUrl('/ws/orchestrator'), (event) => {
      try {
        const payload = JSON.parse(event.data) as {
          type?: string;
          trigger?: string;
          status?: OrchestratorStatusResponse;
          event?: (BrainTranscriptEvent & {
            chatMessageId?: string | null;
            dequeued?: boolean;
          }) | null;
        };
        if (payload.type !== 'orchestrator_status' || !payload.status) {
          return;
        }

        setOrchestratorStatus(payload.status);

        if (payload.trigger === 'task_cancel_requested' && payload.event?.dequeued && payload.event.chatMessageId) {
          setChatMessages((current) => updateChatMessageStatus(current, payload.event?.chatMessageId ?? null, 'cancelled', ['pending', 'queued']));
          return;
        }

        if (payload.trigger === 'task_started') {
          setLiveBrainTranscript(null);
          return;
        }

        if (payload.trigger !== 'brain_transcript' || !payload.event) {
          return;
        }

        const taskId = typeof payload.event.taskId === 'string' ? payload.event.taskId : '';
        const paneLines = Array.isArray(payload.event.paneLines)
          ? payload.event.paneLines.filter((line): line is string => typeof line === 'string')
          : [];
        if (!taskId) return;

        const transcriptText = paneLines.join('\n').trim();
        setLiveBrainTranscript({
          taskId,
          text: transcriptText,
        });
        setTaskTranscripts((current) => (
          current[taskId] === transcriptText
            ? current
            : {
              ...current,
              [taskId]: transcriptText,
            }
        ));
      } catch {
        // ignore malformed messages
      }
    });

    return dispose;
  }, []);

  useEffect(() => {
    const dispose = createReconnectingWs(createWsUrl('/ws/agent-progress'), (event) => {
      try {
        const payload = JSON.parse(event.data) as {
          type?: string;
          trigger?: string;
          event?: {
            event?: string;
            taskId?: string;
            suggestionId?: string;
            suggestionIds?: string[];
            phase?: string;
            detail?: string | null;
          };
        };
        if (payload.type !== 'agent_progress' || !payload.event) return;

        const evt = payload.event;

        // Handle progress updates
        if (evt.event === 'code_fix_progress' && evt.suggestionId && evt.phase) {
          setCodeFixProgressMap((current) => ({
            ...current,
            [evt.suggestionId as string]: {
              phase: evt.phase as string,
              detail: evt.detail ?? null,
            },
          }));
          return;
        }

        // Handle lifecycle transitions (running, merged, failed)
        const suggestionIds = evt.suggestionIds ?? (evt.suggestionId ? [evt.suggestionId] : []);

        if (evt.event === 'code_fix_orchestrator_batch_running') {
          setSuggestionStatusOverrides((current) => {
            const next = { ...current };
            for (const id of suggestionIds) next[id] = 'running';
            return next;
          });
        } else if (evt.event === 'code_fix_orchestrator_batch_merged') {
          setSuggestionStatusOverrides((current) => {
            const next = { ...current };
            for (const id of suggestionIds) next[id] = 'merged';
            return next;
          });
          setCodeFixProgressMap((current) => {
            const next = { ...current };
            for (const id of suggestionIds) next[id] = { phase: 'done', detail: null };
            return next;
          });
        } else if (evt.event === 'code_fix_orchestrator_batch_failed' || evt.event === 'code_fix_orchestrator_dispatch_failed') {
          setSuggestionStatusOverrides((current) => {
            const next = { ...current };
            for (const id of suggestionIds) next[id] = 'failed';
            return next;
          });
          setCodeFixProgressMap((current) => {
            const next = { ...current };
            for (const id of suggestionIds) next[id] = { phase: 'failed', detail: null };
            return next;
          });
        }
      } catch {
        // ignore malformed messages
      }
    });

    return dispose;
  }, []);

  useEffect(() => {
    const target = sentinelRef.current;
    if (!target) return;

    const observer = new IntersectionObserver((entries) => {
      const entry = entries[0];
      if (!entry?.isIntersecting || isFetchingRef.current || !hasMore) return;
      fetchFeed(false);
    }, { rootMargin: '1200px 0px' });

    observer.observe(target);

    return () => observer.disconnect();
  }, [fetchFeed, hasMore]);

  useEffect(() => {
    let cancelled = false;

    const checkActivityStatus = async () => {
      try {
        const response = await fetch('/api/status', { cache: 'no-store' });
        if (!response.ok) throw new Error(`Error ${response.status}`);
        const data = (await response.json()) as {
          sessionExists: boolean;
          working: boolean;
          orchestrator?: OrchestratorStatusResponse | null;
        };

        if (cancelled) return;
        setActivity({ sessionExists: data.sessionExists, working: data.working });
        if (data.orchestrator) {
          setOrchestratorStatus(data.orchestrator);
        }
      } catch {
        if (cancelled) return;
        setActivity({ sessionExists: false, working: false });
      }
    };

    const checkOrchestratorStatus = async () => {
      try {
        const response = await fetch('/api/orchestrator/status', { cache: 'no-store' });
        if (!response.ok) return;
        const data = (await response.json()) as OrchestratorStatusResponse;
        if (cancelled) return;
        setOrchestratorStatus(data);
      } catch {
        // best effort sync for spinner/task state
      }
    };

    const checkStatus = async () => {
      await Promise.all([
        checkActivityStatus(),
        checkOrchestratorStatus(),
      ]);
    };

    void checkStatus();
    const timer = window.setInterval(() => {
      void checkStatus();
    }, hasActiveChatTask ? ACTIVE_CHAT_STATUS_SYNC_INTERVAL_MS : STATUS_SYNC_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [hasActiveChatTask]);

  useEffect(() => {
    if (!isCurationPipelineActive) return;

    let cancelled = false;

    const pollCurationStatus = async () => {
      try {
        const response = await fetch('/api/orchestrator/status', { cache: 'no-store' });
        if (!response.ok) return;
        const data = (await response.json()) as OrchestratorStatusResponse;
        if (cancelled) return;
        setOrchestratorStatus(data);
      } catch {
        // best effort realtime curation status sync
      }
    };

    void pollCurationStatus();
    const timer = window.setInterval(() => {
      void pollCurationStatus();
    }, CURATION_STATUS_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [isCurationPipelineActive]);

  useEffect(() => {
    if (!isCurationPipelineActive) return;

    let cancelled = false;

    const pollFeedForNewItems = async () => {
      if (cancelled) return;
      await syncRecentFeedItems();
    };

    void pollFeedForNewItems();
    const timer = window.setInterval(() => {
      void pollFeedForNewItems();
    }, CURATION_FEED_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [isCurationPipelineActive, syncRecentFeedItems]);

  const submitThreadFeedback = useCallback(async (input: {
    threadId: string;
    cycleId: string;
    threadTitle: string;
    vote: 'up' | 'down';
    reason: string;
    feedbackProbe?: FeedbackProbeMetadata | null;
    sourceItemIds?: string[];
  }) => {
    const matchingThreadItem = pendingItems.find((item) => (
      readTrimmedMetadataString(item.metadata?.cycleId) === input.cycleId
      && readTrimmedMetadataString(item.metadata?.thread?.threadId) === input.threadId
    )) ?? items.find((item) => (
      readTrimmedMetadataString(item.metadata?.cycleId) === input.cycleId
      && readTrimmedMetadataString(item.metadata?.thread?.threadId) === input.threadId
    )) ?? null;
    const originSessionId = readTrimmedMetadataString(matchingThreadItem?.metadata?.originSessionId)
      ?? readTrimmedMetadataString(matchingThreadItem?.originSessionId);
    const originSession = originSessionId
      ? conversationSessions.find((session) => session.sessionId === originSessionId) ?? null
      : null;

    if (input.feedbackProbe) {
      if (!matchingThreadItem) {
        throw new Error('Unable to find the thread item for feedback.');
      }

      const normalizedTitle = input.threadTitle.trim() || 'Thread';
      const normalizedReason = input.reason.trim();
      let response: Response | null = null;
      try {
        response = await fetch('/api/interactions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            feedItemId: matchingThreadItem.id,
            action: 'thread_feedback',
            threadFeedback: {
              threadId: input.threadId,
              cycleId: input.cycleId,
              vote: input.vote === 'up' ? 'more' : 'less',
              threadTitle: normalizedTitle,
              reason: normalizedReason,
              category: input.feedbackProbe.category ?? null,
              probeReason: input.feedbackProbe.reason ?? null,
              probeUncertainty: input.feedbackProbe.uncertainty ?? null,
              sourceItemIds: input.sourceItemIds ?? input.feedbackProbe.sourceItemIds ?? [],
              originSessionId,
            },
          }),
        });
        const data = (await response.json()) as { ok?: boolean; error?: string };
        if (!response.ok || !data.ok) {
          throw new Error(
            isAuthFailure(response, null)
              ? AUTH_REQUIRED_MESSAGE
              : data.error || 'Unable to save thread feedback',
          );
        }
      } catch (error) {
        const message = isAuthFailure(response, error)
          ? AUTH_REQUIRED_MESSAGE
          : error instanceof Error
            ? error.message
            : 'Unable to save thread feedback';
        setChatStatus(message);
        throw new Error(message);
      }
      setChatStatus(null);
      return;
    }

    const routedCuratorSession = originSession?.sessionType === 'curator'
      ? originSession
      : curatorSessions[0] ?? null;
    let feedbackSessionId = routedCuratorSession?.sessionId ?? null;

    if (!feedbackSessionId) {
      if (!curatorSessions[0]) {
        openCuratorSessionCreateModal();
        throw new Error('Create a curator session before sending thread feedback.');
      }
      if (!feedbackSessionId && !targetSessionId) {
        throw new Error('Unable to find a curator session for thread feedback.');
      }
      if (!feedbackSessionId) {
        const fallbackSessionId = targetSessionId;
        if (!fallbackSessionId) {
          throw new Error('Unable to find a non-curator fallback session for thread feedback.');
        }
        feedbackSessionId = fallbackSessionId;
        setChatStatus('No curator session was available, so thread feedback is being sent to the active non-curator session.');
      }
    } else {
      setChatStatus(null);
    }

    const normalizedTitle = input.threadTitle.trim() || 'Thread';
    const normalizedReason = input.reason.trim();
    const message = `Thread feedback: ${input.vote === 'up' ? 'thumbs up' : 'thumbs down'} on "${normalizedTitle}".${normalizedReason ? ` Reason: ${normalizedReason}` : ''}`;
    const context = [
      'Thread feedback:',
      `Thread ID: ${input.threadId}`,
      `Cycle ID: ${input.cycleId}`,
      `Vote: ${input.vote}`,
      `Title: ${normalizedTitle}`,
      `Reason: ${normalizedReason || '(none)'}`,
    ].join('\n');

    let response: Response | null = null;
    try {
      response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          context,
          inReplyTo: null,
          sessionId: feedbackSessionId,
          contextKind: 'global',
          contextRefId: null,
          originView: hasOpenDetailView ? 'post_detail' : 'feed',
          metadata: {
            threadFeedback: {
              threadId: input.threadId,
              cycleId: input.cycleId,
              vote: input.vote,
              threadTitle: normalizedTitle,
              reason: normalizedReason,
            },
          },
        }),
      });
      if (isAuthFailure(response, null)) {
        throw new Error(resolveChatFetchErrorMessage(response, null, 'Unable to save thread feedback'));
      }

      const data = (await response.json()) as {
        ok?: boolean;
        message?: string;
        userMessage?: ChatMessage;
        sessionId?: string | null;
      };

      if (data.userMessage) {
        setChatMessages((current) => mergeChatMessages(current, [data.userMessage as ChatMessage]));
      }

      if (!response.ok || !data.ok) {
        throw new Error(data.message || 'Unable to save thread feedback');
      }

      if (data.sessionId) {
        hydratedConversationSessionIdsRef.current.delete(data.sessionId);
        void refreshConversationSessionSummary(data.sessionId);
        updateSelectedChatSession(data.sessionId, { pauseAutoCorrection: false });
      }
    } catch (error) {
      const message = resolveChatFetchErrorMessage(response, error, 'Unable to save thread feedback');
      setChatStatus(message);
      throw new Error(message);
    }
  }, [
    conversationSessions,
    curatorSessions,
    hasOpenDetailView,
    items,
    openCuratorSessionCreateModal,
    pendingItems,
    refreshConversationSessionSummary,
    targetSessionId,
    updateSelectedChatSession,
  ]);

  const sendChat = useCallback(async () => {
    const message = chatInput.trim();
    if (!message || isSendingChat || isUploadingChatAttachments) return;

    const contextualizedMessage = chatPostContext
      ? `Chat: ${message}${POST_CONTEXT_SEPARATOR}\nTitle: ${chatPostContext.title || chatPostContext.text.slice(0, 100)}\nAuthor: ${chatPostContext.authorDisplayName || chatPostContext.authorUsername || 'Unknown'}\nSource: ${chatPostContext.source || 'Unknown'}\nURL: ${chatPostContext.url || 'n/a'}\nFull text: ${chatPostContext.text}${chatPostContext.metadata?.quotedTweet ? `\nQuoted tweet by @${chatPostContext.metadata.quotedTweet.author.username}: ${chatPostContext.metadata.quotedTweet.text}` : ''}${chatSelectedText ? `\nThe user highlighted this specific text: "${chatSelectedText}"` : ''}\nReason included: ${chatPostContext.reason || 'n/a'}`
      : message;

    setIsSendingChat(true);
    setChatStatus(null);
    streamingSupersededRef.current = false;
    setBrainTyping(true);
    setChatProgress(null);
    setStreamingChat(null);
    setLastChatActivityAt(null);

    let response: Response | null = null;
    try {
      response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: contextualizedMessage,
          context: chatContext,
          inReplyTo: null,
          sessionId: targetSessionId,
          contextKind: 'global',
          contextRefId: null,
          originView: hasOpenDetailView ? 'post_detail' : 'feed',
          attachments: chatAttachments,
        }),
      });
      if (isAuthFailure(response, null)) {
        throw new Error(resolveChatFetchErrorMessage(response, null, 'Unable to send chat message'));
      }

      const data = (await response.json()) as {
        ok?: boolean;
        message?: string;
        userMessage?: ChatMessage;
        sessionId?: string | null;
      };

      if (data.userMessage) {
        setChatMessages((current) => mergeChatMessages(current, [data.userMessage as ChatMessage]));
      }

      if (!response.ok || !data.ok) {
        throw new Error(data.message || 'Unable to send chat message');
      }

      if (data.sessionId) {
        hydratedConversationSessionIdsRef.current.delete(data.sessionId);
        void refreshConversationSessionSummary(data.sessionId);
        updateSelectedChatSession(data.sessionId);
        setConversationHighlightId(data.sessionId);
        setConversationScrollToBottomId(data.sessionId);
        openConversationDetail(data.sessionId, chatPostContext?.id ?? null, {
          replaceTop: true,
        });
      }

      setChatInput('');
      setChatContext(null);
      setChatAttachments([]);
      setChatPostContext(null);
      setChatSelectedText(null);

      // Connect to SSE endpoint for real-time streaming (bypasses WS/Cloudflare issues)
      if (data.userMessage?.id) {
        const messageId = data.userMessage.id;
        try {
          const sseResponse = await fetch(`/api/chat/events?messageId=${encodeURIComponent(messageId)}`);
          if (sseResponse.ok && sseResponse.body) {
            const reader = sseResponse.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            const processSSE = async () => {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';

                let currentEvent = '';
                for (const line of lines) {
                  if (line.startsWith('event: ')) {
                    currentEvent = line.slice(7).trim();
                  } else if (line.startsWith('data: ') && currentEvent) {
                    try {
                      const payload = JSON.parse(line.slice(6));
                      if (currentEvent === 'chat_streaming') {
                        const text = typeof payload.text === 'string' ? payload.text : '';
                        const inReplyTo = typeof payload.inReplyTo === 'string' && payload.inReplyTo ? payload.inReplyTo : null;
                        if (
                          shouldIgnoreSupersededLiveUpdate(
                            chatMessagesRef.current,
                            inReplyTo,
                            streamingSupersededRef.current,
                          )
                        ) {
                          continue;
                        }
                        markChatActivity();
                        const sessionId = typeof payload.sessionId === 'string' && payload.sessionId.trim()
                          ? payload.sessionId.trim()
                          : resolveChatSessionIdFromInReplyTo(chatMessagesRef.current, inReplyTo);
                        if (text) {
                          rememberLiveActivity(sessionId, {
                            label: 'Streaming reply',
                            detail: getStreamingPreviewLine(text),
                            badge: 'Live',
                            status: 'running',
                          });
                        }
                        setStreamingChat(text ? { text, inReplyTo, sessionId } : null);
                        if (text) setChatProgress(null);
                      } else if (currentEvent === 'chat_progress') {
                        const inReplyTo = typeof payload.inReplyTo === 'string' && payload.inReplyTo ? payload.inReplyTo : null;
                        if (
                          shouldIgnoreSupersededLiveUpdate(
                            chatMessagesRef.current,
                            inReplyTo,
                            streamingSupersededRef.current,
                          )
                        ) {
                          continue;
                        }
                        markChatActivity();
                        const activity = typeof payload.activity === 'string' ? payload.activity : '';
                        const tool = typeof payload.tool === 'string' && payload.tool ? payload.tool : 'Working';
                        const sessionId = typeof payload.sessionId === 'string' && payload.sessionId.trim()
                          ? payload.sessionId.trim()
                          : resolveChatSessionIdFromInReplyTo(chatMessagesRef.current, inReplyTo);
                        if (activity.trim()) {
                          rememberLiveActivity(sessionId, {
                            label: 'Tool activity',
                            detail: activity,
                            badge: tool,
                            status: 'running',
                          });
                        }
                        setChatProgress({
                          activity,
                          tool,
                          inReplyTo,
                          sessionId,
                        });
                      } else if (currentEvent === 'chat_done') {
                        if (payload.item) {
                          const deliveredMessage = payload.item as ChatMessage;
                          clearDeliveredAgentChatState([deliveredMessage]);
                          setChatMessages((current) => mergeChatMessages(current, [deliveredMessage]));
                        }
                      }
                    } catch { /* skip malformed events */ }
                    currentEvent = '';
                  } else if (line.trim() === '') {
                    currentEvent = '';
                  }
                }
              }
            };

            // Run SSE processing in background (don't await — sendChat returns immediately)
            void processSSE().catch(() => {
              // SSE connection failed or closed — the polling fallback will catch it
            });
          }
        } catch {
          // SSE connection failed — the polling fallback will catch it
        }
      }
    } catch (error) {
      setBrainTyping(false);
      setChatProgress(null);
      setChatStatus(resolveChatFetchErrorMessage(response, error, 'Failed to send chat message'));
    } finally {
      setIsSendingChat(false);
    }
  }, [
    chatAttachments,
    chatContext,
    chatInput,
    chatPostContext,
    chatSelectedText,
    clearDeliveredAgentChatState,
    hasOpenDetailView,
    isSendingChat,
    isUploadingChatAttachments,
    markChatActivity,
    openConversationDetail,
    rememberLiveActivity,
    refreshConversationSessionSummary,
    targetSessionId,
    updateSelectedChatSession,
  ]);

  const handleChatAttachmentFiles = useCallback(async (files: File[]) => {
    if (files.length === 0 || isUploadingChatAttachments || isSendingChat) {
      return;
    }

    setIsUploadingChatAttachments(true);
    setChatStatus(null);

    const { uploaded, failures } = await uploadChatAttachmentFiles(files);

    if (uploaded.length > 0) {
      setChatAttachments((current) => mergeComposerAttachments(current, uploaded));
      focusChatInput(uploaded.length > 0);
    }

    setChatStatus(failures[0] ?? null);
    setIsUploadingChatAttachments(false);
  }, [focusChatInput, isSendingChat, isUploadingChatAttachments]);

  const handleChatAttachmentSelection = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    await handleChatAttachmentFiles(files);
  }, [handleChatAttachmentFiles]);

  const handleChatComposerDragEnter = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!isChatComposerFileTransfer(event.dataTransfer)) return;

    event.preventDefault();
    event.stopPropagation();
    chatAttachmentDragDepthRef.current += 1;
    if (!isSendingChat && !isUploadingChatAttachments) {
      event.dataTransfer.dropEffect = 'copy';
      setIsChatAttachmentDragActive(true);
    } else {
      event.dataTransfer.dropEffect = 'none';
    }
  }, [isSendingChat, isUploadingChatAttachments]);

  const handleChatComposerDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!isChatComposerFileTransfer(event.dataTransfer)) return;

    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = isSendingChat || isUploadingChatAttachments ? 'none' : 'copy';
  }, [isSendingChat, isUploadingChatAttachments]);

  const handleChatComposerDragLeave = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!isChatComposerFileTransfer(event.dataTransfer)) return;

    event.preventDefault();
    event.stopPropagation();
    chatAttachmentDragDepthRef.current = Math.max(0, chatAttachmentDragDepthRef.current - 1);
    if (chatAttachmentDragDepthRef.current === 0) {
      setIsChatAttachmentDragActive(false);
    }
  }, []);

  const handleChatComposerDrop = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!isChatComposerFileTransfer(event.dataTransfer)) return;

    const files = getChatComposerTransferFiles(event.dataTransfer);
    event.preventDefault();
    event.stopPropagation();
    chatAttachmentDragDepthRef.current = 0;
    setIsChatAttachmentDragActive(false);
    if (files.length > 0) {
      void handleChatAttachmentFiles(files);
    }
  }, [handleChatAttachmentFiles]);

  const removeChatAttachment = useCallback((filePath: string) => {
    setChatAttachments((current) => current.filter((attachment) => attachment.filePath !== filePath));
  }, []);

  const loadAgentTranscript = useCallback(async (target: AgentTranscriptTarget, markLoading: boolean) => {
    const { key, agentId, logFile } = target;

    if (markLoading) {
      setAgentTranscripts((current) => ({
        ...current,
        [key]: {
          loading: true,
          error: null,
          agent: current[key]?.agent ?? null,
          text: current[key]?.text ?? null,
          source: current[key]?.source ?? null,
        },
      }));
    }

    try {
      if (logFile) {
        const response = await fetch(`/api/agents/transcript?file=${encodeURIComponent(logFile)}`);
        if (!response.ok) {
          throw new Error(`Error ${response.status}`);
        }

        const data = (await response.json()) as { transcript?: string };
        setAgentTranscripts((current) => ({
          ...current,
          [key]: {
            loading: false,
            error: null,
            agent: null,
            text: typeof data.transcript === 'string' ? data.transcript : '',
            source: 'log_file',
          },
        }));
        return;
      }

      if (!agentId) {
        throw new Error('Missing transcript source');
      }

      const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}`);
      if (!response.ok) {
        throw new Error(`Error ${response.status}`);
      }

      const data = (await response.json()) as { agent?: AgentTranscriptData };
      setAgentTranscripts((current) => ({
        ...current,
        [key]: {
          loading: false,
          error: null,
          agent: data.agent ?? null,
          text: null,
          source: 'agent',
        },
      }));
    } catch {
      setAgentTranscripts((current) => {
        const previous = current[key];
        const hasPreviousTranscript = Boolean(previous && (previous.agent || previous.text !== null));
        return {
          ...current,
          [key]: {
            loading: false,
            error: hasPreviousTranscript ? null : 'Failed to load transcript.',
            agent: previous?.agent ?? null,
            text: previous?.text ?? null,
            source: previous?.source ?? null,
          },
        };
      });
    }
  }, []);

  const handleAgentTranscriptToggle = useCallback((target: AgentTranscriptTarget) => {
    if (expandedAgentTranscript?.key === target.key) {
      setExpandedAgentTranscript(null);
      return;
    }

    setExpandedAgentTranscript(target);
    if (target.taskId) {
      const existingFallback = taskTranscriptFallbacks[target.taskId];
      const shouldRefreshFromLogFile = Boolean(target.logFile && existingFallback?.source !== 'log_file');
      if (!existingFallback?.loading && (existingFallback?.text === undefined || shouldRefreshFromLogFile)) {
        void loadTaskTranscriptFallback(target.taskId, target.logFile ?? null, true);
      }
      return;
    }
    const existing = agentTranscripts[target.key];
    if (existing?.loading) {
      return;
    }
    const shouldMarkLoading = !existing || (existing.agent === null && existing.text === null);
    void loadAgentTranscript(target, shouldMarkLoading);
  }, [
    agentTranscripts,
    expandedAgentTranscript,
    loadAgentTranscript,
    loadTaskTranscriptFallback,
    taskTranscriptFallbacks,
  ]);

  useEffect(() => {
    if (!expandedAgentTranscript) {
      return;
    }

    if (expandedAgentTranscript.taskId && expandedAgentTranscript.logFile) {
      const target = expandedAgentTranscript;
      const taskId = typeof target.taskId === 'string' && target.taskId ? target.taskId : null;
      const logFile = typeof target.logFile === 'string' && target.logFile ? target.logFile : null;
      if (!taskId || !logFile) {
        return;
      }

      void loadTaskTranscriptFallback(taskId, logFile, false);

      if (orchestratorStatus?.currentTask?.id !== taskId) {
        return;
      }

      const timer = window.setInterval(() => {
        void loadTaskTranscriptFallback(taskId, logFile, false);
      }, CURATION_STATUS_POLL_INTERVAL_MS);

      return () => {
        window.clearInterval(timer);
      };
    }

    const target = expandedAgentTranscript;
    const timer = window.setInterval(() => {
      void loadAgentTranscript(target, false);
    }, 5000);

    return () => {
      window.clearInterval(timer);
    };
  }, [expandedAgentTranscript, loadAgentTranscript, loadTaskTranscriptFallback, orchestratorStatus?.currentTask?.id]);

  const handleInlineCodeFixSuggestionDecision = useCallback(async (
    suggestion: InlineCodeFixChatSuggestion,
    decision: ConfigSuggestionDecision,
  ) => {
    if (suggestionPendingActions[suggestion.id]) return;

    const matchingFeedSuggestion = itemsRef.current.find((item) => item.id === suggestion.id) ?? null;
    const previousStatus = suggestionStatusOverrides[suggestion.id]
      ?? (matchingFeedSuggestion?.type === 'suggestion' ? matchingFeedSuggestion.suggestionStatus : null)
      ?? suggestion.status;
    const pendingAction = decision === 'accepted' ? 'accept' : 'dismiss';

    setChatStatus(null);
    setSuggestionFeedback((current) => {
      if (!(suggestion.id in current)) return current;
      const next = { ...current };
      delete next[suggestion.id];
      return next;
    });
    setSuggestionPendingActions((current) => ({ ...current, [suggestion.id]: pendingAction }));

    if (decision === 'rejected') {
      setSuggestionStatusOverrides((current) => ({ ...current, [suggestion.id]: 'dismissed' }));
    }

    let actionResponse: Response | null = null;
    try {
      if (decision === 'accepted') {
        actionResponse = await fetch('/api/suggestions/batch-accept', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ suggestionIds: [suggestion.id] }),
        });
        const applyResponse = actionResponse;

        if (!applyResponse.ok) {
          throw new Error(isAuthFailure(applyResponse, null)
            ? AUTH_REQUIRED_MESSAGE
            : await readSuggestionActionErrorMessage(
              applyResponse,
              `Failed to apply suggestion (${applyResponse.status}).`,
            ));
        }

        const applyResult = (await applyResponse.json()) as SuggestionApplyResponse;
        const nextStatus = applyResult.suggestionStatus ?? 'dispatched';
        if (!wasSuggestionApplySuccessful(applyResult)) {
          setSuggestionStatusOverrides((current) => ({
            ...current,
            ...(nextStatus ? { [suggestion.id]: nextStatus } : {}),
          }));
          if (previousStatus === 'pending' && nextStatus !== 'pending') {
            adjustPendingCounts({ suggestion: -1 });
          }
          const failureMessage = applyResult.message || 'Failed to apply suggestion.';
          setSuggestionFeedback((current) => ({
            ...current,
            [suggestion.id]: failureMessage,
          }));
          setChatStatus(failureMessage);
          return;
        }

        setSuggestionStatusOverrides((current) => ({
          ...current,
          [suggestion.id]: nextStatus,
        }));
        if (previousStatus === 'pending' && nextStatus !== 'pending') {
          adjustPendingCounts({ suggestion: -1 });
        }
        setSuggestionFeedback((current) => ({
          ...current,
          [suggestion.id]: getSuggestionApplySuccessMessage(applyResult),
        }));
        return;
      }

      actionResponse = await fetch('/api/interactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          feedItemId: suggestion.id,
          action: 'dismiss_suggestion',
        }),
      });
      const response = actionResponse;

      if (!response.ok) {
        throw new Error(isAuthFailure(response, null) ? AUTH_REQUIRED_MESSAGE : `Error ${response.status}`);
      }

      if (previousStatus === 'pending') {
        adjustPendingCounts({ suggestion: -1 });
      }
    } catch (error) {
      setSuggestionStatusOverrides((current) => ({ ...current, [suggestion.id]: previousStatus }));
      const isAuthFailureMessage = isAuthFailure(actionResponse, error);
      const failureMessage = isAuthFailureMessage
        ? AUTH_REQUIRED_MESSAGE
        : error instanceof Error && error.message.trim()
          ? error.message
          : (decision === 'accepted' ? 'Failed to apply suggestion.' : 'Failed to dismiss suggestion.');
      setSuggestionFeedback((current) => ({
        ...current,
        [suggestion.id]: decision === 'accepted' || isAuthFailureMessage ? failureMessage : 'Failed to dismiss suggestion.',
      }));
      setChatStatus(failureMessage);
    } finally {
      setSuggestionPendingActions((current) => ({ ...current, [suggestion.id]: null }));
    }
  }, [adjustPendingCounts, suggestionPendingActions, suggestionStatusOverrides]);


  const handleFeedSuggestionAccept = useCallback(async (item: FeedItem) => {
    if (item.type !== 'suggestion') return;
    if (suggestionPendingActions[item.id]) return;

    const previousStatus = resolveSuggestionStatus(item);
    setSuggestionFeedback((current) => {
      const next = { ...current };
      delete next[item.id];
      return next;
    });
    setSuggestionPendingActions((current) => ({ ...current, [item.id]: 'accept' }));

    let applyResponse: Response | null = null;
    try {
      const applyRequest = buildSuggestionApplyRequest(item);
      applyResponse = await fetch('/api/suggestions/batch-accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(applyRequest),
      });

      if (!applyResponse.ok) {
        throw new Error(isAuthFailure(applyResponse, null)
          ? AUTH_REQUIRED_MESSAGE
          : await readSuggestionActionErrorMessage(
            applyResponse,
            `Failed to apply suggestion (${applyResponse.status}).`,
          ));
      }

      const applyResult = (await applyResponse.json()) as SuggestionApplyResponse;
      const nextStatus = applyResult.suggestionStatus ?? 'dispatched';

      if (!wasSuggestionApplySuccessful(applyResult)) {
        if (nextStatus) {
          setSuggestionStatusOverrides((current) => ({
            ...current,
            [item.id]: nextStatus,
          }));
          if (previousStatus === 'pending' && nextStatus !== 'pending') {
            adjustPendingCounts({ suggestion: -1 });
          }
        }
        setSuggestionFeedback((current) => ({
          ...current,
          [item.id]: applyResult.message || 'Could not dispatch the dev agent.',
        }));
        return;
      }

      setSuggestionStatusOverrides((current) => ({
        ...current,
        [item.id]: nextStatus,
      }));
      if (previousStatus === 'pending' && nextStatus && nextStatus !== 'pending') {
        adjustPendingCounts({ suggestion: -1 });
      }
      setSuggestionFeedback((current) => ({
        ...current,
        [item.id]: getSuggestionApplySuccessMessage(applyResult),
      }));
    } catch (error) {
      setSuggestionFeedback((current) => ({
        ...current,
        [item.id]: isAuthFailure(applyResponse, error)
          ? AUTH_REQUIRED_MESSAGE
          : error instanceof Error && error.message.trim()
            ? error.message
            : 'Failed to apply suggestion.',
      }));
    } finally {
      setSuggestionPendingActions((current) => ({ ...current, [item.id]: null }));
    }
  }, [adjustPendingCounts, resolveSuggestionStatus, suggestionPendingActions]);

  const handleFeedSuggestionDismiss = useCallback(async (item: FeedItem) => {
    if (item.type !== 'suggestion') return;
    if (suggestionPendingActions[item.id]) return;

    const previousStatus = resolveSuggestionStatus(item);
    setSuggestionPendingActions((current) => ({ ...current, [item.id]: 'dismiss' }));
    setSuggestionStatusOverrides((current) => ({ ...current, [item.id]: 'dismissed' }));

    let response: Response | null = null;
    try {
      response = await fetch('/api/interactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          feedItemId: item.id,
          action: 'dismiss_suggestion',
        }),
      });

      if (!response.ok) {
        throw new Error(isAuthFailure(response, null) ? AUTH_REQUIRED_MESSAGE : `Error ${response.status}`);
      }
      if (previousStatus === 'pending') {
        adjustPendingCounts({ suggestion: -1 });
      }
    } catch (error) {
      setSuggestionStatusOverrides((current) => ({ ...current, [item.id]: previousStatus }));
      setSuggestionFeedback((current) => ({
        ...current,
        [item.id]: isAuthFailure(response, error) ? AUTH_REQUIRED_MESSAGE : 'Failed to dismiss suggestion.',
      }));
    } finally {
      setSuggestionPendingActions((current) => ({ ...current, [item.id]: null }));
    }
  }, [adjustPendingCounts, resolveSuggestionStatus, suggestionPendingActions]);

  const handleFeedSuggestionRetry = useCallback(async (item: FeedItem) => {
    if (item.type !== 'suggestion') return;
    if (suggestionPendingActions[item.id]) return;

    const previousStatus = resolveSuggestionStatus(item);
    setSuggestionPendingActions((current) => ({ ...current, [item.id]: 'accept' }));

    let response: Response | null = null;
    try {
      response = await fetch('/api/suggestions/retry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ suggestionId: item.id }),
      });

      if (!response.ok) {
        throw new Error(isAuthFailure(response, null) ? AUTH_REQUIRED_MESSAGE : `Error ${response.status}`);
      }

      setSuggestionStatusOverrides((current) => ({ ...current, [item.id]: 'pending' }));
      if (previousStatus !== 'pending') {
        adjustPendingCounts({ suggestion: 1 });
      }
      setCodeFixProgressMap((current) => {
        const next = { ...current };
        delete next[item.id];
        return next;
      });
      setSuggestionFeedback((current) => ({ ...current, [item.id]: 'Reset to pending. You can accept it again.' }));
    } catch (error) {
      setSuggestionFeedback((current) => ({
        ...current,
        [item.id]: isAuthFailure(response, error) ? AUTH_REQUIRED_MESSAGE : 'Failed to retry suggestion.',
      }));
    } finally {
      setSuggestionPendingActions((current) => ({ ...current, [item.id]: null }));
    }
  }, [adjustPendingCounts, resolveSuggestionStatus, suggestionPendingActions]);

  const handleFeedSuggestionCancel = useCallback(async (item: FeedItem) => {
    if (item.type !== 'suggestion') return;
    const taskId = typeof item.metadata?.taskId === 'string' ? item.metadata.taskId : null;
    if (!taskId) return;

    setSuggestionPendingActions((current) => ({ ...current, [item.id]: 'dismiss' }));

    let response: Response | null = null;
    try {
      response = await fetch('/api/internal/code-fix-orchestrator/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId }),
      });

      if (!response.ok) {
        throw new Error(isAuthFailure(response, null) ? AUTH_REQUIRED_MESSAGE : `Error ${response.status}`);
      }

      setSuggestionStatusOverrides((current) => ({ ...current, [item.id]: 'failed' }));
      setCodeFixProgressMap((current) => {
        const next = { ...current };
        next[item.id] = { phase: 'failed', detail: 'Cancelled by user' };
        return next;
      });
      setSuggestionFeedback((current) => ({ ...current, [item.id]: 'Cancelled. You can retry when ready.' }));
    } catch (error) {
      setSuggestionFeedback((current) => ({
        ...current,
        [item.id]: isAuthFailure(response, error) ? AUTH_REQUIRED_MESSAGE : 'Failed to cancel task.',
      }));
    } finally {
      setSuggestionPendingActions((current) => ({ ...current, [item.id]: null }));
    }
  }, []);

  const handleFeedSuggestionBatchAccept = useCallback(async (groupItems: FeedItem[]) => {
    const pendingItems = groupItems.filter((item) => (
      item.type === 'suggestion' && resolveSuggestionStatus(item) === 'pending'
    ));

    if (pendingItems.length === 0) {
      return;
    }

    if (!pendingItems.every((item) => isCodeFixSuggestion(item))) {
      for (const item of pendingItems) {
        await handleFeedSuggestionAccept(item);
      }
      return;
    }

    setSuggestionFeedback((current) => {
      const next = { ...current };
      for (const item of pendingItems) {
        delete next[item.id];
      }
      return next;
    });
    setSuggestionPendingActions((current) => {
      const next = { ...current };
      for (const item of pendingItems) {
        next[item.id] = 'accept';
      }
      return next;
    });

    let response: Response | null = null;
    try {
      response = await fetch('/api/suggestions/batch-accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          suggestionIds: pendingItems.map((item) => item.id),
        }),
      });

      if (!response.ok) {
        throw new Error(isAuthFailure(response, null)
          ? AUTH_REQUIRED_MESSAGE
          : await readSuggestionActionErrorMessage(
            response,
            `Failed to apply suggestion (${response.status}).`,
          ));
      }

      const result = await response.json() as { taskId?: string; suggestionStatus?: SuggestionStatus };
      const baseMessage = typeof result.taskId === 'string' && result.taskId.trim()
        ? `Dev agent dispatched (${result.taskId.trim()}).`
        : 'Dev agent dispatched.';

      setSuggestionStatusOverrides((current) => {
        const next = { ...current };
        for (const item of pendingItems) {
          next[item.id] = result.suggestionStatus ?? 'dispatched';
        }
        return next;
      });
      adjustPendingCounts({ suggestion: -pendingItems.length });
      setSuggestionFeedback((current) => {
        const next = { ...current };
        for (const item of pendingItems) {
          next[item.id] = baseMessage;
        }
        return next;
      });

    } catch (error) {
      const failureMessage = isAuthFailure(response, error)
        ? AUTH_REQUIRED_MESSAGE
        : error instanceof Error && error.message.trim()
          ? error.message
          : 'Failed to apply suggestion.';
      setSuggestionFeedback((current) => {
        const next = { ...current };
        for (const item of pendingItems) {
          next[item.id] = failureMessage;
        }
        return next;
      });
    } finally {
      setSuggestionPendingActions((current) => {
        const next = { ...current };
        for (const item of pendingItems) {
          next[item.id] = null;
        }
        return next;
      });
    }
  }, [
    adjustPendingCounts,
    handleFeedSuggestionAccept,
    resolveSuggestionStatus,
  ]);

  const handleFeedSuggestionBatchDismiss = useCallback(async (groupItems: FeedItem[]) => {
    for (const item of groupItems) {
      await handleFeedSuggestionDismiss(item);
    }
  }, [handleFeedSuggestionDismiss]);

  const handleNotificationDismiss = useCallback(async (item: FeedItem) => {
    if (item.type !== 'notification') return;
    if (notificationPendingActions[item.id]) return;
    const wasActiveNotification = isActiveNotification(item);

    setNotificationFeedback((current) => {
      const next = { ...current };
      delete next[item.id];
      return next;
    });
    setNotificationPendingActions((current) => ({ ...current, [item.id]: 'dismiss' }));

    try {
      const notificationId = typeof item.metadata?.notificationId === 'string'
        ? item.metadata.notificationId.trim()
        : '';
      const response = await fetch('/api/internal/notifications/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedItemId: item.id, notificationId: notificationId || undefined }),
      });

      if (!response.ok) {
        throw new Error(`Error ${response.status}`);
      }

      const result = await response.json();
      if (!result.resolved) {
        throw new Error('Dismiss was not persisted');
      }
      if (wasActiveNotification) {
        adjustPendingCounts({ notification: -1 });
      }

      setItems((current) => current.map((entry) => (
        entry.id === item.id ? { ...entry, suggestionStatus: 'dismissed' } : entry
      )));
      setPendingItems((current) => current.filter((entry) => entry.id !== item.id));
    } catch {
      setNotificationFeedback((current) => ({
        ...current,
        [item.id]: 'Failed to dismiss notification.',
      }));
    } finally {
      setNotificationPendingActions((current) => ({ ...current, [item.id]: null }));
    }
  }, [adjustPendingCounts, notificationPendingActions]);

  const handleChatInputFocus = useCallback(() => {
    if (chatPostContext === null) {
      const activeDetailEntry = detailStackRef.current[detailStackRef.current.length - 1] ?? null;
      if (activeDetailEntry?.kind === 'post') {
        const activeDetailItem = resolveFeedItemById(activeDetailEntry.routeId);
        if (activeDetailItem) {
          setChatPostContext(activeDetailItem);
        }
      }
    }

    if (!isMobileViewport) return;
    window.requestAnimationFrame(() => {
      chatInputRef.current?.scrollIntoView({ block: 'end' });
      window.setTimeout(() => {
        chatInputRef.current?.scrollIntoView({ block: 'end' });
      }, 280);
    });
  }, [chatPostContext, isMobileViewport, resolveFeedItemById]);

  const resizeChatInput = useCallback(() => {
    const element = chatInputRef.current;
    if (!element) return;

    element.style.height = 'auto';
    const nextHeight = Math.min(element.scrollHeight, CHAT_INPUT_MAX_HEIGHT_PX);
    element.style.height = `${nextHeight}px`;
    element.style.overflowY = element.scrollHeight > CHAT_INPUT_MAX_HEIGHT_PX ? 'auto' : 'hidden';
  }, []);

  useEffect(() => {
    const element = chatInputElement;
    if (!element) return;

    element.setAttribute('autocomplete', 'off');

    const currentText = normalizeChatComposerText(element.innerText);
    if (currentText !== chatInput) {
      element.textContent = chatInput;
    }
  }, [chatInput, chatInputElement]);

  useEffect(() => {
    const element = chatInputElement;
    if (!element) return;

    const handlePaste = (event: globalThis.ClipboardEvent) => {
      event.preventDefault();

      const plainText = normalizeChatComposerText(event.clipboardData?.getData('text/plain') ?? '');
      if (plainText) {
        insertPlainTextIntoContentEditable(element, plainText);
      }

      setChatInput(normalizeChatComposerText(element.innerText));
    };

    element.addEventListener('paste', handlePaste);
    return () => {
      element.removeEventListener('paste', handlePaste);
    };
  }, [chatInputElement]);

  useEffect(() => {
    resizeChatInput();
  }, [chatInput, resizeChatInput]);

  const isMobileKeyboardVisible = isMobileViewport && mobileKeyboardInset > 120;
  const visibleFeedEntryCount = visibleFeedEntries.length;
  const isEmptyFeedLoading = isLoading && visibleFeedEntryCount === 0;
  const measuredComposerHeight = Math.max(chatComposerHeight, 0);
  const baseComposerReservedHeight = measuredComposerHeight > 0
    ? measuredComposerHeight + CHAT_COMPOSER_GAP_PX
    : CHAT_COMPOSER_MIN_RESERVED_HEIGHT_PX;
  const feedComposerReservedHeight = (!showConfigEditor && !showPreferencesPanel && !isChatDetailOpen)
    ? baseComposerReservedHeight
    : CHAT_COMPOSER_GAP_PX;
  const chatDetailComposerReservedHeight = (!showConfigEditor && !showPreferencesPanel && isChatDetailOpen)
    ? baseComposerReservedHeight
    : CHAT_COMPOSER_GAP_PX;
  const currentSession = conversationSessions.find((s) => s.sessionId === targetSessionId) ?? null;
  const sessionLabel = currentSession?.title || (conversationSessions.length > 0 ? DEFAULT_GENERAL_AGENT_SESSION_TITLE : 'New session');
  const sessionMessageCount = currentSession?.messageCount ?? 0;
  const restartStatus = restartState?.status ?? null;
  const restartHeadline = restartStatus === 'pending'
    ? 'Update available'
    : restartStatus === 'failed'
      ? 'Restart failed'
      : restartStatus === 'consumed'
        ? 'Restart completed'
        : restartStatus === 'restarting'
          ? 'Restarting service'
          : restartStatus === 'applying'
            ? 'Applying update'
            : null;
  const shouldRenderRestartBanner = Boolean(
    restartState
    && restartHeadline
    && (restartStatus !== 'consumed' || restartReloadPending),
  );
  const restartBannerClassName = restartStatus === 'failed'
    ? 'border-red-600/40 bg-red-950/30'
    : restartStatus === 'consumed'
      ? 'border-sky-600/40 bg-sky-950/30'
      : 'border-emerald-600/40 bg-emerald-950/30';
  const restartHeadlineClassName = restartStatus === 'failed'
    ? 'text-red-200'
    : restartStatus === 'consumed'
      ? 'text-sky-200'
      : 'text-emerald-200';
  const restartSummaryClassName = restartStatus === 'failed'
    ? 'text-red-300/80'
    : restartStatus === 'consumed'
      ? 'text-sky-300/80'
      : 'text-emerald-400/70';
  const restartDetailLines = restartState ? [
    restartState.summary?.trim() ? restartState.summary.trim() : 'Code update',
    restartState.commit ? `Commit ${restartState.commit}` : null,
    restartState.mergedAt ? `Merged ${formatAbsoluteTimestamp(restartState.mergedAt)}` : null,
    restartState.applyRequestedAt ? `Apply requested ${formatAbsoluteTimestamp(restartState.applyRequestedAt)}` : null,
    restartState.requestedBy ? `Triggered by ${restartState.requestedBy}${restartState.triggerSource ? ` via ${restartState.triggerSource}` : ''}` : null,
    restartState.serviceReadyAt ? `Service ready ${formatAbsoluteTimestamp(restartState.serviceReadyAt)}` : null,
    restartState.error ? `Error: ${restartState.error}` : null,
  ].filter((value): value is string => Boolean(value)) : [];
  const renderChatSessionHeaderTitle = (
    session: ConversationSessionSummary | null,
    fallbackTitle: string,
  ): ReactNode => {
    const sessionId = session?.sessionId ?? null;
    const sessionMessages = sessionId ? chatMessages.filter((message) => message.sessionId === sessionId) : [];
    const contextBarMetrics = getChatSessionContextHeaderMetrics(session);
    const hasPendingSessionMessage = sessionMessages.some((message) => (
      message.type === 'chat'
      && (message.status === 'pending' || message.status === 'queued' || message.status === 'processing')
    ));
    const streamingSessionId = visibleStreamingChat?.sessionId?.trim()
      || resolveChatSessionIdFromInReplyTo(sessionMessages, visibleStreamingChat?.inReplyTo ?? null);
    const progressSessionId = effectiveChatProgress?.sessionId?.trim()
      || resolveChatSessionIdFromInReplyTo(sessionMessages, effectiveChatProgress?.inReplyTo ?? null);
    const rawCompactionState = sessionId ? compactingSessionIds[sessionId] : null;
    const compactionState = rawCompactionState && !isChatSessionCompactionStateStale(rawCompactionState)
      ? rawCompactionState
      : null;
    const hasLiveSessionActivity = Boolean(
      (streamingSessionId && sessionId && streamingSessionId === sessionId)
      || (progressSessionId && sessionId && progressSessionId === sessionId)
      || (isSendingChat && targetSessionId === sessionId)
    );
    const hasActiveChatTurn = Boolean(
      (sessionId && getActiveChatTaskForConversation(sessionId, sessionMessages, orchestratorStatus))
      || hasPendingSessionMessage
      || hasLiveSessionActivity
    );
    const isCompactPopoverOpen = sessionId !== null && chatSessionCompactPopover?.sessionId === sessionId;
    const compactButtonState = session ? getChatSessionCompactButtonState({
      provider: session.provider,
      phase: compactionState?.phase ?? null,
      hasActiveChatTurn,
    }) : null;
    const compactDisabled = compactButtonState?.disabled ?? true;
    const compactButtonLabel = compactButtonState?.label ?? 'Compact';
    const compactDisabledTitle = compactButtonState?.title ?? 'Compact this session to replace long history with a shorter summary.';
    const compactContextLabel = `Context: ${contextBarMetrics?.utilizationPercent ?? 0}% (${formatCompactTokenCount(contextBarMetrics?.contextTokens ?? 0)} / ${formatCompactTokenCount(contextBarMetrics?.limit ?? 0)})`;
    const compactButtonClassName = `inline-flex min-h-9 w-full items-center justify-center rounded-xl border px-3 py-2 text-sm font-medium transition ${
      compactDisabled
        ? 'border-zinc-800 bg-zinc-950 text-zinc-500'
        : hasActiveChatTurn
          ? 'border-sky-500/40 bg-sky-500/10 text-sky-100 hover:border-sky-400/60'
          : contextBarMetrics?.status === 'critical'
            ? 'border-red-500/40 bg-red-500/10 text-red-100 hover:border-red-400/60'
            : contextBarMetrics?.status === 'warn'
              ? 'border-amber-500/40 bg-amber-500/10 text-amber-100 hover:border-amber-400/60'
              : 'border-zinc-700/80 bg-zinc-900/80 text-zinc-100 hover:border-zinc-500 hover:bg-zinc-900'
    } disabled:cursor-not-allowed disabled:opacity-40`;

    return (
      <div className="flex min-w-0 items-center gap-1.5 sm:gap-2">
        <span className="max-w-[7.25rem] shrink-0 truncate text-[15px] font-semibold leading-tight text-zinc-100 sm:max-w-none sm:text-base">{session?.title ?? fallbackTitle}</span>
        {contextBarMetrics ? (
          <span ref={chatSessionCompactPopoverRef} className="relative inline-flex shrink-0 items-center">
            <button
              type="button"
              onClick={() => toggleChatSessionCompactPopover(session)}
              title={compactContextLabel}
              aria-label={compactContextLabel}
              aria-haspopup="dialog"
              aria-expanded={isCompactPopoverOpen}
              aria-controls={isCompactPopoverOpen && sessionId ? `chat-session-compact-popover-${sessionId}` : undefined}
              className={`inline-flex h-2.5 w-12 shrink-0 overflow-hidden rounded-full bg-zinc-900/80 ring-1 ring-inset ring-zinc-700/60 transition hover:ring-zinc-500/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 sm:h-4 sm:w-24 ${
                isCompactPopoverOpen ? 'ring-sky-400/70' : ''
              }`}
            >
              <span
                className={`${contextBarMetrics.status === 'critical' ? 'bg-red-400/90' : contextBarMetrics.status === 'warn' ? 'bg-amber-400/90' : 'bg-zinc-500/70'} h-full rounded-full transition-[width] duration-200 ease-out`}
                style={{
                  width: `${Math.max(0, Math.min(100, contextBarMetrics.utilizationPercent))}%`,
                  minWidth: contextBarMetrics.contextTokens > 0 ? '1px' : undefined,
                }}
              />
            </button>
            {isCompactPopoverOpen ? (
              <div
                id={sessionId ? `chat-session-compact-popover-${sessionId}` : undefined}
                role="dialog"
                aria-label="Context details"
                className="absolute right-0 top-full z-30 mt-2 w-44 max-w-[calc(100vw-2rem)] rounded-2xl border border-zinc-700/80 bg-zinc-950 p-3 shadow-2xl sm:w-48"
              >
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-400">Context</p>
                <p className="mt-2 text-lg font-semibold text-zinc-100">{contextBarMetrics.utilizationPercent}% used</p>
                <p className="mt-1 text-sm text-zinc-400">
                  {formatCompactTokenCount(contextBarMetrics.contextTokens)} / {formatCompactTokenCount(contextBarMetrics.limit)}
                </p>
                <div className="mt-3">
                  <button
                    type="button"
                    onClick={() => void compactSelectedChatSession(session)}
                    disabled={compactDisabled}
                    title={compactDisabledTitle}
                    className={compactButtonClassName}
                  >
                    {compactButtonLabel}
                  </button>
                  {compactButtonState?.unavailableReason ? (
                    <p className="mt-2 text-xs leading-snug text-zinc-500">{compactButtonState.unavailableReason}</p>
                  ) : null}
                </div>
              </div>
            ) : null}
          </span>
        ) : null}
      </div>
    );
  };
  const renderChatSessionReasoningPopover = (
    session: ConversationSessionSummary,
    alignmentClassName: string,
  ) => {
    const sessionId = session.sessionId;
    const isCodexSession = session.provider === 'codex';
    const options = isCodexSession ? CODEX_REASONING_OPTIONS : CLAUDE_REASONING_OPTIONS;

    return (
      <div
        ref={chatSessionReasoningPopoverRef}
        className={`absolute z-30 w-52 rounded-2xl border border-zinc-700/80 bg-zinc-950 p-2 shadow-2xl ${alignmentClassName}`}
      >
        <p className="px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-400">Reasoning Level</p>
        <div className="mt-1 grid gap-1">
          {options.map((option) => {
            const isSelected = isCodexSession
              ? session.codexReasoningEffort === option.value
              : session.claudeReasoningEffort === option.value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  if (isCodexSession) {
                    void updateCodexSessionSettings(session, { codexReasoningEffort: option.value as CodexReasoningEffort });
                    return;
                  }
                  void updateClaudeSessionReasoningEffort(session, option.value as ClaudeReasoningEffort);
                }}
                disabled={chatSessionReasoningPendingSessionId === sessionId}
                className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-sm transition ${
                  isSelected
                    ? 'bg-sky-500/10 text-sky-100'
                    : 'text-zinc-200 hover:bg-zinc-900'
                } disabled:cursor-not-allowed disabled:opacity-60`}
              >
                <span>{option.label}</span>
                {isSelected ? <span className="text-[11px] text-sky-300">Current</span> : null}
              </button>
            );
          })}
        </div>
        {isCodexSession ? (
          <button
            type="button"
            onClick={() => void updateCodexSessionSettings(session, { codexFastMode: !session.codexFastMode })}
            disabled={chatSessionReasoningPendingSessionId === sessionId}
            className="mt-2 flex w-full items-center justify-between gap-3 border-t border-zinc-800 px-3 py-2 text-left text-sm text-zinc-200 transition hover:bg-zinc-900 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span>Fast mode</span>
            <span className={`rounded-full border px-2 py-0.5 text-[11px] ${
              session.codexFastMode
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
                : 'border-zinc-700 bg-zinc-900 text-zinc-500'
            }`}>
              {session.codexFastMode ? 'On' : 'Off'}
            </span>
          </button>
        ) : null}
      </div>
    );
  };
  const renderChatSessionHeaderActions = (session: ConversationSessionSummary | null) => {
    const sessionId = session?.sessionId ?? null;
    if (!session || !sessionId) return null;
    const canDeleteSession = conversationSessions.length > 1;
    const isClaudeSession = session.provider === 'claude';
    const isCodexSession = session.provider === 'codex';
    const isProviderWithReasoningSettings = isClaudeSession || isCodexSession;
    const isMenuPopoverOpen = chatSessionReasoningPopover?.sessionId === sessionId
      && chatSessionReasoningPopover.anchor === 'menu';
    const sessionTint = getSessionTint(sessionId, session.color);

    const curatorActions = session.sessionType === 'curator' ? (
      <CuratorCurateButtons
        disabled={isCurateDisabled || isSendingChat}
        tint={sessionTint}
        showIcon={false}
        fullLabelMinRowWidth={CURATOR_CURATE_HEADER_FULL_LABEL_MIN_ROW_WIDTH}
        className="flex shrink-0 items-center gap-1 sm:gap-2"
        onSubmit={(command) => {
          void submitCurateToSession(sessionId, command);
        }}
      />
    ) : null;
    return (
      <>
        <div ref={chatSessionMenuRef} className="relative shrink-0">
          <button
            type="button"
            onClick={() => {
              setChatSessionCompactPopover(null);
              setChatSessionReasoningPopover(null);
              setChatSessionMenuOpen((open) => !open);
            }}
            className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-zinc-700/80 bg-zinc-950/80 text-zinc-300 transition hover:border-zinc-500 hover:bg-zinc-900 hover:text-zinc-100 sm:h-9 sm:w-9"
            aria-label="More session options"
            aria-expanded={chatSessionMenuOpen}
          >
            <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4">
              <path d="M10 4.25a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5Zm0 4a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5Zm0 4a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5Z" fill="currentColor" />
            </svg>
          </button>
          {chatSessionMenuOpen && (
            <div className="absolute right-0 top-full z-20 mt-2 min-w-48 rounded-2xl border border-zinc-700/80 bg-zinc-950 shadow-2xl">
              {isProviderWithReasoningSettings ? (
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => toggleChatSessionReasoningPopover(session, 'menu')}
                    disabled={chatSessionReasoningPendingSessionId === sessionId || chatSessionActionPending !== null || isRenamingSession}
                    className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm text-zinc-200 transition hover:bg-zinc-900 disabled:cursor-not-allowed disabled:text-zinc-500"
                  >
                    <span>Reasoning Level</span>
                    <span className="text-xs text-zinc-500">
                      {isCodexSession
                        ? `${formatCodexReasoningEffortLabel(session.codexReasoningEffort)}${session.codexFastMode ? ' · Fast' : ''}`
                        : formatClaudeReasoningEffortLabel(session.claudeReasoningEffort)}
                    </span>
                  </button>
                  {isMenuPopoverOpen ? renderChatSessionReasoningPopover(session, 'right-full top-0 mr-2') : null}
                </div>
              ) : null}
              <button
                type="button"
                onClick={() => openRenameSessionModal(session)}
                disabled={chatSessionActionPending !== null || isRenamingSession}
                className={`flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm text-zinc-200 transition hover:bg-zinc-900 disabled:cursor-not-allowed disabled:text-zinc-500 ${isProviderWithReasoningSettings ? 'border-t border-zinc-800' : ''}`}
              >
                <span>Rename Session</span>
              </button>
              <button
                type="button"
                onClick={() => void resetSelectedChatSession(sessionId)}
                disabled={chatSessionActionPending !== null}
                className="flex w-full items-center justify-between gap-3 border-t border-zinc-800 px-4 py-3 text-left text-sm text-zinc-200 transition hover:bg-zinc-900 disabled:cursor-not-allowed disabled:text-zinc-500"
              >
                <span>Reset Session</span>
                {chatSessionActionPending === 'reset' && <span className="text-xs text-zinc-500">Working...</span>}
              </button>
              {canDeleteSession && (
                <button
                  type="button"
                  onClick={() => void deleteSelectedChatSession(sessionId)}
                  disabled={chatSessionActionPending !== null}
                  className="flex w-full items-center justify-between gap-3 border-t border-zinc-800 px-4 py-3 text-left text-sm text-red-200 transition hover:bg-zinc-900 disabled:cursor-not-allowed disabled:text-zinc-500"
                >
                  <span>Delete Session</span>
                  {chatSessionActionPending === 'delete' && <span className="text-xs text-zinc-500">Working...</span>}
                </button>
              )}
            </div>
          )}
        </div>
        {curatorActions}
      </>
    );
  };
  const renderChatSessionHeaderSubtitle = (
    session: ConversationSessionSummary | null,
    workingDirectoryLabel: string | undefined,
  ): ReactNode => {
    const providerLabel = session?.provider ? getChatSessionHeaderProviderLabel(session.provider) : null;
    const sessionId = session?.sessionId ?? null;
    const isBadgePopoverOpen = sessionId !== null
      && chatSessionReasoningPopover?.sessionId === sessionId
      && chatSessionReasoningPopover.anchor === 'badge';
    const providerNode = providerLabel ? (
      <span className="inline-flex items-center gap-1.5">
        <span>{providerLabel}</span>
        {session && (session.provider === 'claude' || session.provider === 'codex') && sessionId ? (
          <span className="relative inline-flex items-center gap-1">
            <button
              type="button"
              onClick={() => toggleChatSessionReasoningPopover(session, 'badge')}
              disabled={chatSessionReasoningPendingSessionId === sessionId}
              aria-expanded={isBadgePopoverOpen}
              className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium transition ${
                isBadgePopoverOpen
                  ? 'border-sky-400/60 bg-sky-500/10 text-sky-100'
                  : 'border-zinc-700/80 bg-zinc-900/80 text-zinc-300 hover:border-zinc-500 hover:text-zinc-100'
              } disabled:cursor-not-allowed disabled:opacity-60`}
            >
              {session.provider === 'codex'
                ? formatCodexReasoningEffortLabel(session.codexReasoningEffort)
                : formatClaudeReasoningEffortLabel(session.claudeReasoningEffort)}
            </button>
            {session.provider === 'codex' && session.codexFastMode ? (
              <span
                className="inline-flex items-center rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-200"
                title="Fast mode is enabled for this Codex session"
              >
                Fast
              </span>
            ) : null}
            {isBadgePopoverOpen ? renderChatSessionReasoningPopover(session, 'left-0 top-full mt-2') : null}
          </span>
        ) : null}
      </span>
    ) : null;
    const subtitleParts = [
      providerNode,
      workingDirectoryLabel ? <span key="working-directory">{workingDirectoryLabel}</span> : null,
    ]
      .filter(Boolean) as ReactNode[];

    return subtitleParts.length > 0 ? (
      <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500">
        {subtitleParts.map((part, index) => (
          <Fragment key={index}>
            {index > 0 ? <span aria-hidden="true" className="text-zinc-700">·</span> : null}
            <span className="min-w-0">{part}</span>
          </Fragment>
        ))}
      </p>
    ) : undefined;
  };
  const renderChatComposerPanel = (mode: 'feed' | 'detail' = 'feed') => (
    <div
      ref={handleChatComposerElement}
      className={`pointer-events-none fixed inset-x-0 bottom-0 z-[60] px-2 ${
        mode === 'detail'
          ? 'sm:mx-auto sm:max-w-3xl sm:px-2'
          : 'sm:px-4'
      } ${isMobileKeyboardVisible ? 'pb-0' : 'pb-[max(0.25rem,env(safe-area-inset-bottom))]'}`}
      style={isMobileViewport && mobileKeyboardInset > 0 ? { bottom: `${mobileKeyboardInset}px` } : undefined}
    >
      <NewSessionModal
        claudeReasoningEffort={newSessionClaudeReasoningEffort}
        claudeReasoningOptions={CLAUDE_REASONING_OPTIONS}
        codexReasoningEffort={newSessionCodexReasoningEffort}
        codexReasoningOptions={CODEX_REASONING_OPTIONS}
        codexFastMode={newSessionCodexFastMode}
        colorOptions={SESSION_TINT_PALETTE.map((tint) => ({
          value: tint.name,
          swatch: tint.swatch,
        }))}
        error={newSessionModalError}
        isOpen={isCreateSessionModalOpen}
        isProviderLoading={isLoadingBrainProviderStatus}
        isSubmitting={isCreatingSession}
        provider={newSessionProvider}
        providerError={brainProviderStatusError}
        providerOptions={availableNewSessionProviders}
        selectedColor={newSessionColor}
        sessionType={newSessionType}
        title={newSessionTitle}
        workingDirectory={newSessionWorkingDirectory}
        onClose={closeCreateSessionModal}
        onAskAgent={createSessionForAgentSetup}
        onSubmit={() => void createSessionFromModal()}
        onClaudeReasoningEffortChange={(value) => setNewSessionClaudeReasoningEffort(value as ClaudeReasoningEffort)}
        onCodexReasoningEffortChange={(value) => setNewSessionCodexReasoningEffort(value as CodexReasoningEffort)}
        onCodexFastModeChange={setNewSessionCodexFastMode}
        onColorChange={setNewSessionColor}
        onProviderChange={(value) => setNewSessionProvider(value as BrainProviderName)}
        onSessionTypeChange={setNewSessionType}
        onTitleChange={setNewSessionTitle}
        onWorkingDirectoryChange={setNewSessionWorkingDirectory}
      />
      {brainState === 'unavailable' && (
        <div className="pointer-events-auto relative mb-2 mx-auto w-full max-w-3xl">
          <AgentUnavailableBanner
            providerDisplayName={brainProviderInfo.providerDisplayName}
            providerBinary={brainProviderInfo.providerBinary}
          />
        </div>
      )}
      <div aria-hidden="true" className="absolute -inset-x-2 bottom-0 top-[-0.875rem] rounded-[2rem] bg-zinc-950/95 blur-xl" />
      <div
        data-testid="chat-composer-panel"
        onDragEnter={handleChatComposerDragEnter}
        onDragOver={handleChatComposerDragOver}
        onDragLeave={handleChatComposerDragLeave}
        onDrop={handleChatComposerDrop}
        className={`pointer-events-auto relative mx-auto w-full max-w-3xl rounded-[1.75rem] bg-zinc-950/95 px-3 pt-3 pb-2 shadow-[0_-4px_12px_rgba(0,0,0,0.18),0_-1px_4px_rgba(0,0,0,0.14),0_0_0_1px_rgba(255,255,255,0.04)] backdrop-blur transition ${
          isChatAttachmentDragActive
            ? '[@media(pointer:fine)]:ring-2 [@media(pointer:fine)]:ring-sky-400/70 [@media(pointer:fine)]:ring-offset-2 [@media(pointer:fine)]:ring-offset-black'
            : ''
        }`}
      >
        {isChatAttachmentDragActive && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-1 hidden rounded-[1.55rem] border border-dashed border-sky-300/70 bg-sky-500/8 [@media(pointer:fine)]:block"
          />
        )}
        {sessionPickerOpen && (
          <>
            <div
              className="fixed inset-0 z-[61] bg-black/40"
              onClick={() => {
                setSessionPickerOpen(false);
              }}
            />
            <div
              ref={sessionPickerRef}
              className="absolute inset-x-0 bottom-full z-[62] mx-3 mb-2 max-h-80 overflow-y-auto rounded-2xl border border-zinc-700/80 bg-zinc-900 shadow-2xl"
              data-testid="session-picker-dropdown"
            >
              <div className="flex items-center justify-between border-b border-zinc-700/60 px-4 py-3">
                <span className="text-sm font-semibold text-zinc-200">Select Session</span>
                <button
                  type="button"
                  onClick={() => {
                    setSessionPickerOpen(false);
                  }}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-full text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-200"
                  aria-label="Close session picker"
                >
                  <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4">
                    <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22z" fill="currentColor" />
                  </svg>
                </button>
              </div>
              {sessionPickerSessions.map((session) => {
                const isActive = session.sessionId === targetSessionId;
                const sessionTitle = session.title;
                return (
                  <button
                    key={session.sessionId}
                    type="button"
                    onClick={() => selectSessionFromPicker(session.sessionId)}
                    className={`flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors ${
                      isActive
                        ? 'bg-sky-500/10 text-sky-100'
                        : 'text-zinc-300 hover:bg-zinc-800/60'
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium">{sessionTitle}</span>
                        <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] ${
                          session.provider === brainProviderInfo.provider
                            ? 'border-sky-500/30 bg-sky-500/10 text-sky-200'
                            : 'border-zinc-700 bg-zinc-900 text-zinc-500'
                        }`}>
                          {getProviderChipLabel(session.provider)}
                        </span>
                        {session.sessionType === 'curator' ? (
                          <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-amber-100">
                            Curator
                          </span>
                        ) : null}
                        {isActive && (
                          <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4 shrink-0 text-sky-400">
                            <path d="M16.704 4.153a.75.75 0 0 1 .143 1.052l-8 10.5a.75.75 0 0 1-1.127.075l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 0 1 1.05-.143z" fill="currentColor" />
                          </svg>
                        )}
                      </div>
                      <div className="mt-0.5 text-xs text-zinc-500">
                        {session.messageCount > 0 ? `${session.messageCount} message${session.messageCount !== 1 ? 's' : ''}` : 'No messages yet'}
                        {session.lastMaterialActivityAt && (
                          <> &middot; {new Date(session.lastMaterialActivityAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })}
              <button
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  openCreateSessionModal();
                }}
                className="flex w-full items-center gap-2 border-t border-zinc-700/60 px-4 py-2.5 text-left text-sm text-sky-300 transition-colors hover:bg-zinc-800/60"
                data-testid="new-session-button"
              >
                <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4">
                  <path d="M10 5a.75.75 0 0 1 .75.75v3.5h3.5a.75.75 0 0 1 0 1.5h-3.5v3.5a.75.75 0 0 1-1.5 0v-3.5h-3.5a.75.75 0 0 1 0-1.5h3.5v-3.5A.75.75 0 0 1 10 5z" fill="currentColor" />
                </svg>
                New session
              </button>
            </div>
          </>
        )}

        {commandPickerOpen && (
          <>
            <div
              className="fixed inset-0 z-[61] bg-black/40"
              onClick={closeCommandPicker}
            />
            <div
              className="absolute inset-x-0 bottom-full z-[62] mx-3 mb-2 max-h-80 overflow-y-auto rounded-2xl border border-zinc-700/80 bg-zinc-900 shadow-2xl"
              data-testid="chat-command-picker-sheet"
            >
              <div className="flex items-center justify-between border-b border-zinc-700/60 px-4 py-3">
                <span className="text-sm font-semibold text-zinc-200">Slash Commands</span>
                <button
                  type="button"
                  onClick={closeCommandPicker}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-full text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-200"
                  aria-label="Close slash command picker"
                >
                  <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4">
                    <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22z" fill="currentColor" />
                  </svg>
                </button>
              </div>

              <div className="overflow-y-auto p-2">
                {chatCommandsStatus === 'loading' && (
                  <div className="rounded-2xl border border-zinc-800 bg-black/30 px-4 py-6 text-center text-sm text-zinc-400">
                    Loading commands...
                  </div>
                )}

                {chatCommandsStatus === 'error' && (
                  <div className="rounded-2xl border border-red-900/60 bg-red-950/30 px-4 py-4 text-sm text-red-100">
                    <p>{chatCommandsError || 'Failed to load commands.'}</p>
                    <button
                      type="button"
                      onClick={() => void loadChatCommands()}
                      className="mt-3 inline-flex h-9 items-center rounded-full border border-red-800/80 px-3 text-xs font-medium text-red-100 transition hover:bg-red-950/50"
                    >
                      Retry
                    </button>
                  </div>
                )}

                {chatCommandsStatus === 'loaded' && chatCommands.length === 0 && (
                  <div className="rounded-2xl border border-zinc-800 bg-black/30 px-4 py-6 text-center text-sm text-zinc-400">
                    No slash commands are available.
                  </div>
                )}

                {chatCommands.length > 0 && (
                  <div className="space-y-1">
                    {chatCommands.map((command) => (
                      <button
                        key={`${command.source}:${command.name}`}
                        type="button"
                        onClick={() => applyChatCommand(command.name)}
                        data-testid={`chat-command-option-${command.name}`}
                        className="flex w-full items-start rounded-2xl px-3 py-3 text-left transition hover:bg-zinc-800/60"
                      >
                        <div className="min-w-0 flex-1">
                          <span className="text-sm font-medium text-zinc-100">/{command.name}</span>
                          <p className="mt-1 text-sm leading-5 text-zinc-400">{command.description}</p>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </>
        )}

        {(chatPostContext || chatContext || chatAttachments.length > 0) && (
          <div className="mb-2 flex flex-wrap items-start gap-2">
            {chatPostContext && (
              <div className="inline-flex min-w-0 max-w-full items-center gap-2 overflow-hidden rounded-full border border-sky-500/20 bg-sky-500/10 px-3 py-1.5 text-xs text-sky-100">
                <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
                  <span className="shrink-0 text-[11px] font-medium uppercase tracking-[0.16em] text-sky-200/75">Discussing</span>
                  <span className="truncate text-zinc-100">
                    {chatPostContext.title || chatPostContext.text.substring(0, 100) || 'Untitled post'}
                  </span>
                </div>
                <button
                  type="button"
                  aria-label="Clear discussed post"
                  onClick={() => {
                    setChatPostContext(null);
                    setChatSelectedText(null);
                  }}
                  className="mt-[-0.125rem] mr-[-0.25rem] inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/10 bg-black/15 text-sm text-sky-100 transition hover:border-white/20 hover:bg-black/30"
                >
                  ×
                </button>
              </div>
            )}

            {chatAttachments.map((attachment) => (
              <ChatAttachmentCard
                key={attachment.filePath}
                attachment={attachment}
                onRemove={() => removeChatAttachment(attachment.filePath)}
              />
            ))}

            {chatContext && (
              <div className="inline-flex items-center gap-2 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1.5 text-[11px] text-emerald-100">
                <span className="font-medium uppercase tracking-[0.16em] text-emerald-200/80">Context attached</span>
                <button
                  type="button"
                  onClick={() => setChatContext(null)}
                  className="mr-[-0.25rem] inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-black/15 text-sm text-emerald-100 transition hover:border-white/20 hover:bg-black/30"
                  aria-label="Clear selection context"
                >
                  ×
                </button>
              </div>
            )}
          </div>
        )}

        {compactFeedback && (
          <div
            role={compactFeedback.tone === 'error' ? 'alert' : 'status'}
            className={`mb-3 rounded-xl border px-3 py-2 text-xs shadow-lg ${
              compactFeedback.tone === 'error'
                ? 'border-red-500/40 bg-red-500/12 text-red-100'
                : 'border-sky-500/40 bg-sky-500/12 text-sky-100'
            }`}
          >
            {compactFeedback.message}
          </div>
        )}

        <form
          {...CHAT_COMPOSER_FORM_TEXT_ENTRY_ATTRIBUTES}
          onSubmit={(event) => {
            event.preventDefault();
            void sendChat();
          }}
        >
          <input
            ref={chatAttachmentInputRef}
            type="file"
            multiple
            accept={CHAT_ATTACHMENT_ACCEPT}
            onChange={handleChatAttachmentSelection}
            data-testid="chat-attachment-input"
            className="sr-only"
            tabIndex={-1}
          />
          <div
            className="w-full rounded-xl border border-zinc-700/80 bg-zinc-950/80 transition duration-150 focus-within:border-sky-500/60 focus-within:ring-2 focus-within:ring-sky-500/20"
            onPointerDown={(event) => {
              if (!isMobileViewport || isSendingChat) return;
              if (document.activeElement === chatInputRef.current) return;
              event.preventDefault();
              focusChatInput(true);
            }}
          >
            <div
              ref={handleChatInputRef}
              contentEditable={!isSendingChat}
              suppressContentEditableWarning
              tabIndex={isMobileViewport ? -1 : 0}
              role="textbox"
              aria-multiline="true"
              aria-label={`Ask ${agentName} anything...`}
              onInput={(event) => {
                setChatInput(normalizeChatComposerText(event.currentTarget.innerText));
              }}
              onFocus={handleChatInputFocus}
              onKeyDown={(event) => {
                if (!shouldSubmitChatComposerKeyDown({
                  key: event.key,
                  metaKey: event.metaKey,
                  ctrlKey: event.ctrlKey,
                  shiftKey: event.shiftKey,
                  isMobileViewport,
                })) return;

                event.preventDefault();
                void sendChat();
              }}
              inputMode="text"
              enterKeyHint={isMobileViewport ? undefined : 'send'}
              {...CHAT_COMPOSER_TEXTBOX_TEXT_ENTRY_ATTRIBUTES}
              data-empty={chatInput.length === 0 ? 'true' : 'false'}
              data-placeholder={`Ask ${agentName} anything...`}
              data-testid="chat-input"
              className="block min-h-11 w-full overflow-y-auto bg-transparent px-3 py-[11px] text-sm leading-6 text-zinc-100 outline-none"
            />
          </div>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={() => chatAttachmentInputRef.current?.click()}
              disabled={isSendingChat || isUploadingChatAttachments}
              data-testid="chat-attachment-button"
              aria-label="Attach files"
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-200 disabled:cursor-not-allowed disabled:text-zinc-600"
            >
              <svg aria-hidden="true" viewBox="0 0 24 24" className="h-[18px] w-[18px]">
                <path
                  d="M8 12.5 14.5 6a3.5 3.5 0 1 1 5 5l-8.5 8.5a5 5 0 0 1-7-7L12 4.5"
                  className="fill-none stroke-current"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="1.9"
                />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => {
                if (commandPickerOpen) {
                  closeCommandPicker();
                } else {
                  openCommandPicker();
                }
              }}
              disabled={isSendingChat || isUploadingChatAttachments}
              data-testid="chat-command-button"
              aria-label="Open slash command picker"
              className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sm font-semibold transition disabled:cursor-not-allowed disabled:text-zinc-600 ${
                commandPickerOpen
                  ? 'bg-zinc-800 text-zinc-100'
                  : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
              }`}
            >
              /
            </button>
            <button
              type="button"
              onClick={() => {
                closeCommandPicker();
                setSessionPickerOpen((open) => !open);
              }}
              className="inline-flex min-w-0 items-center gap-1.5 rounded-full border border-zinc-700/60 bg-zinc-800/80 px-3 py-1 text-xs text-zinc-300 transition hover:border-zinc-600 hover:bg-zinc-700/80"
              data-testid="session-picker-toggle"
            >
              <span className="truncate">{sessionLabel}</span>
              {sessionMessageCount > 0 && (
                <span className="shrink-0 text-zinc-500">&middot; {sessionMessageCount}</span>
              )}
              <svg
                aria-hidden="true"
                viewBox="0 0 20 20"
                className={`h-3 w-3 shrink-0 text-zinc-500 transition-transform ${sessionPickerOpen ? 'rotate-180' : ''}`}
              >
                <path d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 11.168l3.71-3.938a.75.75 0 1 1 1.08 1.04l-4.25 4.5a.75.75 0 0 1-1.08 0l-4.25-4.5a.75.75 0 0 1 .02-1.06z" fill="currentColor" />
              </svg>
            </button>
            <div className="flex-1" />
            <button
              type="submit"
              disabled={isSendingChat || isUploadingChatAttachments || !chatInput.trim()}
              data-testid="chat-send-button"
              className="inline-flex h-8 shrink-0 items-center justify-center rounded-full border border-sky-500/30 bg-sky-500/15 px-3 text-xs font-medium text-sky-50 transition hover:border-sky-400/50 hover:bg-sky-500/25 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-500"
            >
              {isUploadingChatAttachments ? 'Uploading...' : isSendingChat ? 'Sending...' : 'Send'}
            </button>
          </div>
        </form>
        {chatStatus && (
          <p className="mt-2 rounded-xl border border-zinc-700/70 bg-zinc-900/90 px-3 py-2 text-xs text-zinc-200">
            {chatStatus}
          </p>
        )}
      </div>
    </div>
  );

  return (
    <main data-testid="home-page" className="min-h-screen bg-black pb-[env(safe-area-inset-bottom)] text-zinc-100">
      <header
        ref={appHeaderRef}
        data-testid="app-header"
        className="sticky top-0 z-30"
        style={{ paddingTop: 'max(env(safe-area-inset-top), 0.25rem)' }}
      >
        <div className="mx-auto flex w-full max-w-3xl items-start gap-2 px-2 pb-1 sm:px-3">
          <div className="min-w-0 flex-1 rounded-[1.7rem] bg-zinc-950/95 px-1.5 py-1.5 shadow-[0_10px_26px_rgba(0,0,0,0.18),0_2px_8px_rgba(0,0,0,0.14),0_0_0_1px_rgba(255,255,255,0.04)] backdrop-blur">
            <div className="flex flex-col sm:flex-row sm:items-center sm:gap-1">
              <div className="flex flex-nowrap items-center gap-1 overflow-x-auto whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:hidden">
                {mobileHeaderFilters.map((filter) => (
                  <FeedFilterButton
                    key={filter.value}
                    filter={filter}
                    selected={selectedFilter === filter.value}
                    badgeCount={getFeedFilterBadgeCount(filter.value, pendingCounts)}
                    onClick={() => handleFeedFilterClick(filter.value)}
                  />
                ))}
              </div>
              <div className="hidden flex-nowrap items-center gap-1 overflow-x-auto whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:flex">
                {desktopHeaderFilters.map((filter) => (
                  <FeedFilterButton
                    key={filter.value}
                    filter={filter}
                    selected={selectedFilter === filter.value}
                    badgeCount={getFeedFilterBadgeCount(filter.value, pendingCounts)}
                    onClick={() => handleFeedFilterClick(filter.value)}
                  />
                ))}
              </div>
            </div>
          </div>

          <div className="shrink-0 rounded-2xl bg-zinc-950/95 p-1 shadow-[0_10px_26px_rgba(0,0,0,0.18),0_2px_8px_rgba(0,0,0,0.14),0_0_0_1px_rgba(255,255,255,0.04)] backdrop-blur">
            <button
              type="button"
              onClick={() => setIsMobileMenuOpen(true)}
              data-testid="mobile-menu-button"
              className={`relative inline-flex h-10 w-10 items-center justify-center rounded-full border text-zinc-200 transition-colors ${
                hasActiveSearch
                  ? 'border-sky-500/60 bg-sky-500/15 hover:bg-sky-500/25'
                  : 'border-zinc-700 bg-zinc-900 hover:bg-zinc-800'
              }`}
              aria-label="Open menu and search"
            >
              {hasActiveSearch ? (
                <span
                  aria-hidden="true"
                  className="absolute right-2 top-2 h-2 w-2 rounded-full bg-sky-300 shadow-[0_0_0_2px_rgba(15,23,42,0.95)]"
                />
              ) : null}
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4.5 w-4.5">
                <line x1="3" y1="6" x2="21" y2="6" />
                <line x1="3" y1="12" x2="21" y2="12" />
                <line x1="3" y1="18" x2="21" y2="18" />
              </svg>
            </button>
          </div>
        </div>
      </header>

      {isMobileMenuOpen && (
        <div className="fixed inset-0 z-[70]">
          <div
            className="absolute inset-0 bg-black/60"
            onClick={() => setIsMobileMenuOpen(false)}
          />
          <div
            className="absolute bottom-0 right-0 top-0 flex w-[min(20rem,calc(100vw-0.75rem))] flex-col animate-slideInRight border-l border-zinc-800 bg-zinc-900 pt-[env(safe-area-inset-top)]"
          >
            <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
              <span className="text-sm font-semibold text-zinc-100">Menu</span>
              <button
                type="button"
                onClick={() => setIsMobileMenuOpen(false)}
                className="rounded-lg p-2 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
                aria-label="Close menu"
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="flex min-h-full flex-col p-4">
                <div className="flex flex-col gap-1">
                  <button
                    type="button"
                    onClick={openBrainProviderModal}
                    data-testid="brain-provider-button"
                    className="rounded-lg px-3 py-2.5 text-left text-sm text-zinc-200 transition-colors hover:bg-zinc-800"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span>App brain</span>
                      <span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-[11px] font-medium text-sky-200">
                        {brainProviderInfo.providerDisplayName}
                      </span>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={openUsageModal}
                    data-testid="brain-provider-usage-button"
                    className="self-end shrink-0 mr-3 rounded-md border border-zinc-700 px-2 py-1 text-[11px] font-medium text-zinc-200 transition-colors hover:border-zinc-600 hover:bg-zinc-800"
                  >
                    Usage
                  </button>
                  <SidebarCodeFixReasoningButton
                    provider={brainProviderInfo.provider}
                    value={codeFixReasoningEffort}
                    onOpen={() => {
                      setCodeFixReasoningError(null);
                      setIsMobileMenuOpen(false);
                      setIsCodeFixReasoningModalOpen(true);
                    }}
                  />
                  {hasCuratorSession ? (
                    <SidebarAutomationControls
                      automaticCurationEnabled={automaticCurationEnabled}
                      backgroundSourceBrowsingEnabled={backgroundSourceBrowsingEnabled}
                      configLoaded={Boolean(configContent)}
                      isSavingAutomaticCuration={isSavingAutomaticCuration}
                      isSavingBackgroundSourceBrowsing={isSavingBackgroundSourceBrowsing}
                      isStartingSourceHealth={isStartingSourceHealth}
                      automaticCurationError={automaticCurationError}
                      backgroundSourceBrowsingError={backgroundSourceBrowsingError}
                      onToggleAutomaticCuration={() => {
                        void toggleAutomaticCuration();
                      }}
                      onToggleBackgroundSourceBrowsing={() => {
                        void toggleBackgroundSourceBrowsing();
                      }}
                      onStartSourceHealth={() => {
                        void submitSourceHealthFromSidebar();
                      }}
                    />
                  ) : null}
                  <button
                    type="button"
                    onClick={() => {
                      setIsMobileMenuOpen(false);
                      openCreateSessionModal();
                    }}
                    data-testid="mobile-new-session-button"
                    className="rounded-lg px-3 py-2.5 text-left text-sm text-zinc-200 transition-colors hover:bg-zinc-800"
                  >
                    Create Chat Session
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowPreferencesPanel(true);
                      setIsMobileMenuOpen(false);
                    }}
                    data-testid="preferences-button"
                    className="rounded-lg px-3 py-2.5 text-left text-sm text-zinc-200 transition-colors hover:bg-zinc-800"
                  >
                    Preferences
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowConfigEditor(true);
                      setIsMobileMenuOpen(false);
                    }}
                    data-testid="settings-button"
                    className="rounded-lg px-3 py-2.5 text-left text-sm text-zinc-200 transition-colors hover:bg-zinc-800"
                  >
                    Config
                  </button>
                </div>

                <div className="mt-auto pt-4">
                  <div className="mt-4 border-t border-zinc-800 pt-4">
                    <p className="px-1 pb-2 text-xs font-medium uppercase tracking-wider text-zinc-500">Filters</p>
                    <div className="flex flex-wrap gap-1.5">
                      {feedFilters.map((filter) => (
                        <FeedFilterButton
                          key={filter.value}
                          filter={filter}
                          selected={selectedFilter === filter.value}
                          badgeCount={getFeedFilterBadgeCount(filter.value, pendingCounts)}
                          onClick={() => {
                            setSelectedFilter(filter.value);
                            setIsMobileMenuOpen(false);
                          }}
                        />
                      ))}
                    </div>
                  </div>
                  <section className="mt-4 rounded-2xl border border-zinc-800/90 bg-zinc-950/70 p-3">
                    <div className="flex items-center justify-end gap-3">
                      {hasActiveSearch ? (
                        <span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-[11px] font-medium text-sky-200">
                          Active
                        </span>
                      ) : null}
                    </div>
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        commitSearchQuery(searchDraft);
                        setIsMobileMenuOpen(false);
                      }}
                      className="mt-3"
                    >
                      <div className="flex items-center gap-2 rounded-[1.1rem] border border-zinc-800/80 bg-zinc-900/70 px-3 py-2">
                        <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4 shrink-0 text-zinc-500">
                          <circle cx="9" cy="9" r="5" fill="none" stroke="currentColor" strokeWidth="1.5" />
                          <path d="m13 13 4 4" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" />
                        </svg>
                        <input
                          type="search"
                          value={searchDraft}
                          onChange={(event: ChangeEvent<HTMLInputElement>) => setSearchDraft(normalizeFeedSearchQuery(event.target.value))}
                          placeholder="Search saved feed content"
                          data-testid="feed-search-input"
                          className="min-w-0 flex-1 bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
                        />
                        {searchDraft ? (
                          <button
                            type="button"
                            onClick={() => {
                              commitSearchQuery('', hasActiveSearch ? 'push' : 'replace');
                              setIsMobileMenuOpen(false);
                            }}
                            data-testid="feed-search-clear"
                            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-zinc-700 bg-zinc-950 text-zinc-400 transition hover:border-zinc-600 hover:text-zinc-200"
                            aria-label="Clear search"
                          >
                            ×
                          </button>
                        ) : null}
                      </div>
                      <button
                        type="submit"
                        data-testid="feed-search-submit"
                        className="mt-2 inline-flex w-full items-center justify-center rounded-full border border-sky-500/30 bg-sky-500/15 px-3 py-2 text-[11px] font-medium text-sky-100 transition hover:border-sky-400/50 hover:bg-sky-500/25"
                      >
                        Search
                      </button>
                    </form>
                  </section>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      <div
        aria-hidden={hasOpenDetailView}
        data-feed-overlay-suppressed={hasOpenDetailView ? 'true' : 'false'}
        className={`relative mx-auto w-full max-w-3xl ${hasOpenDetailView ? 'pointer-events-none invisible' : ''}`}
      >
        <section
          data-testid="feed"
          data-feed-content="true"
          className="flex w-full flex-col gap-2 px-0 py-2 sm:px-2"
          style={{ paddingBottom: `${feedComposerReservedHeight}px` }}
        >
          {shouldRenderRestartBanner && restartState && restartHeadline && (
            <div className={`mx-auto flex w-full items-start justify-between gap-3 rounded-xl border px-4 py-3 ${restartBannerClassName}`}>
              <div className="min-w-0">
                <p className={`text-sm font-medium ${restartHeadlineClassName}`}>{restartHeadline}</p>
                {restartDetailLines.map((line, index) => (
                  <p
                    key={`${restartState.status}:${index}:${line}`}
                    className={`break-words text-xs ${index === 0 ? restartSummaryClassName : 'text-zinc-300/80'}`}
                  >
                    {line}
                  </p>
                ))}
              </div>
              {restartState.status === 'pending' ? (
                <button
                  disabled={isApplyingRestart}
                  onClick={async () => {
                    setIsApplyingRestart(true);
                    setRestartReloadPending(true);
                    try {
                      const response = await fetch('/api/internal/apply-restart', {
                        method: 'POST',
                        headers: {
                          'Content-Type': 'application/json',
                          'X-Requested-By': 'evogent-ui',
                          'X-Restart-Source': 'update-available-banner',
                        },
                        body: JSON.stringify({
                          requestedBy: 'evogent-ui',
                          triggerSource: 'update-available-banner',
                        }),
                      });
                      const payload = await response.json() as { ok?: boolean; error?: string; state?: RestartLifecycleState | null };

                      if (!response.ok || !payload.ok) {
                        throw new Error(payload.error || 'Failed to apply update');
                      }

                      setRestartState(payload.state ?? {
                        ...restartState,
                        status: 'applying',
                        applyRequestedAt: new Date().toISOString(),
                        requestedBy: 'evogent-ui',
                        triggerSource: 'update-available-banner',
                      });
                    } catch (error) {
                      setIsApplyingRestart(false);
                      setRestartReloadPending(false);
                      setRestartState((current) => current ? {
                        ...current,
                        status: 'failed',
                        error: error instanceof Error ? error.message : 'Failed to apply update',
                      } : {
                        status: 'failed',
                        commit: restartState.commit,
                        summary: restartState.summary,
                        error: error instanceof Error ? error.message : 'Failed to apply update',
                      });
                    }
                  }}
                  className="shrink-0 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
                >
                  {isApplyingRestart ? 'Applying...' : 'Apply'}
                </button>
              ) : null}
            </div>
          )}
          <PwaInstallBanner />
          {hasCuratorSession && !hasSourceSkillInstalled ? (
            <SetupBanner
              isStarting={isStartingSetupWizard}
              isSetupReady={isSetupReady}
              onStartSetup={submitSetupWizardFromBanner}
            />
          ) : null}
          {/* Agent unavailable banner moved to above composer */}
          {pendingItemCount > 0 && (
            <button
              type="button"
              data-testid="new-posts-button"
              onClick={revealPendingItems}
              className="fixed left-1/2 z-40 -translate-x-1/2 rounded-full border border-blue-400/40 bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-lg transition hover:bg-blue-500 active:bg-blue-700"
              style={{ top: `${headerMeasuredHeight + 12}px` }}
            >
              {pendingItemCount} new post{pendingItemCount === 1 ? '' : 's'}
            </button>
          )}
          {hasActiveSearch && (
            <div
              className="sticky z-20 rounded-xl border border-sky-500/20 bg-zinc-950 px-4 py-3 shadow-[0_8px_20px_rgba(0,0,0,0.24)]"
              style={{ top: `${headerMeasuredHeight}px` }}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-medium uppercase tracking-[0.18em] text-sky-200/80">Search</p>
                  <p className="mt-1 text-sm text-zinc-100">Results for “{searchQuery}” across saved feed content and stored detail items.</p>
                </div>
                <button
                  type="button"
                  onClick={() => commitSearchQuery('')}
                  className="inline-flex shrink-0 items-center justify-center rounded-full border border-sky-400/35 bg-sky-500/12 px-3 py-1.5 text-xs font-medium text-sky-100 transition hover:border-sky-300/55 hover:bg-sky-500/20"
                  aria-label="Clear active search"
                >
                  Clear
                </button>
              </div>
            </div>
          )}
          {shouldShowAgentEntries && feedBannerCurationTask && (
            <CurationTaskCard
              task={feedBannerCurationTask}
              agentName={agentName}
              taskTranscripts={taskTranscripts}
              taskTranscriptFallbacks={taskTranscriptFallbacks}
              orchestratorStatus={orchestratorStatus}
              expandedAgentTranscript={expandedAgentTranscript}
              onToggleTranscript={handleAgentTranscriptToggle}
            />
          )}
          {isEmptyFeedLoading && (
            <FeedEmptyLoadingState />
          )}
          {isLoading && items.length > 0 && <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4 text-sm text-zinc-400">Loading feed...</div>}
          {shouldRenderFeedEmptyState({ isLoading, visibleFeedEntryCount }) && (
            <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-6 text-center">
              {hasActiveSearch ? (
                <>
                  <p className="text-sm text-zinc-300">No matches found</p>
                  <p className="mt-1 text-xs text-zinc-500">Try a broader keyword or clear the current search.</p>
                  <button
                    type="button"
                    onClick={() => commitSearchQuery('')}
                    className="mt-4 rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm text-zinc-100 hover:bg-zinc-700"
                  >
                    Clear search
                  </button>
                </>
              ) : isSetupReady && selectedFilter === 'suggestion' ? (
                <>
                  <p className="text-sm text-zinc-300">No suggestions yet</p>
                  <p className="mt-1 text-xs text-zinc-500">Code fix suggestions will show up here and also directly in the agent chats.</p>
                </>
              ) : (
                <>
                  <p className="text-sm text-zinc-300">{isSetupReady ? 'Ready for curation' : 'Welcome'}</p>
                  <p className="mt-1 text-xs text-zinc-500">
                    {isSetupReady
                      ? 'Start a Curator Agent run, or check Source Health if the first pass finds no items.'
                      : 'Your curated feed will appear here.'}
                  </p>
                </>
              )}
            </div>
          )}

          {visibleFeedEntries.map((entry) => {
            if (entry.kind === 'conversation') {
              const conversation = conversationCardMap[entry.conversationId];
              if (!conversation) return null;
              return (
                <ConversationCard
                  key={`conversation:${conversation.sessionId}`}
                  conversation={conversation}
                  agentName={agentName}
                  sessionTint={getSessionTint(conversation.sessionId, conversation.color)}
                  highlight={conversationHighlightId === conversation.sessionId}
                  streamingChat={visibleStreamingChat}
                  retainedLiveActivity={retainedLiveActivityBySession[conversation.sessionId] ?? null}
                  chatProgress={effectiveChatProgress}
                  isCurateDisabled={isCurateDisabled}
                  isSendingChat={isSendingChat}
                  searchQuery={searchQuery}
                  submitCurateToSession={submitCurateToSession}
                  onOpen={() => {
                    updateSelectedChatSession(conversation.sessionId);
                    if (searchQuery && conversation.searchMatchMessageId) {
                      setConversationScrollToBottomId(null);
                      setConversationScrollToMessage({
                        sessionId: conversation.sessionId,
                        messageId: conversation.searchMatchMessageId,
                      });
                    } else {
                      setConversationScrollToMessage(null);
                      setConversationScrollToBottomId(conversation.sessionId);
                    }
                    openConversationDetail(
                      conversation.sessionId,
                      conversation.contextKind === 'post' ? conversation.contextRefId : null,
                    );
                  }}
                />
              );
            }

            if (entry.kind === 'group') {
              const hasPendingAction = entry.groupType === 'suggestion'
                ? entry.items.some((i) => suggestionPendingActions[i.id] != null)
                : entry.items.some((i) => notificationPendingActions[i.id] != null);

              // Only show batch actions when there are pending suggestions to act on
              const pendingItems = entry.groupType === 'suggestion'
                ? entry.items.filter((i) => resolveSuggestionStatus(i) === 'pending')
                : [];
              const currentCodeFixItems = entry.groupType === 'suggestion'
                ? entry.items.filter((item) => (
                    isCodeFixSuggestion(item) && isCurrentSuggestionStatus(resolveSuggestionStatus(item))
                  ))
                : [];
              const batchActions = entry.groupType === 'suggestion' && pendingItems.length > 0
                ? {
                    acceptAll: {
                      label: hasPendingAction ? 'Working...' : `Accept All (${pendingItems.length})`,
                      disabled: hasPendingAction,
                      onClick: () => handleFeedSuggestionBatchAccept(pendingItems),
                    },
                    dismissAll: {
                      label: hasPendingAction ? 'Working...' : 'Dismiss All',
                      disabled: hasPendingAction,
                      onClick: () => handleFeedSuggestionBatchDismiss(pendingItems),
                    },
                  }
                : undefined;
              const chatAction = entry.groupType === 'suggestion' && currentCodeFixItems.length > 0
                ? {
                    label: 'Chat About Fixes',
                    disabled: hasPendingAction,
                    onClick: () => handleChatAboutSuggestionGroup(currentCodeFixItems),
                  }
                : undefined;

              // Compute status counts for suggestion groups
              const statusCounts = entry.groupType === 'suggestion' ? (() => {
                const counts = { pending: 0, dispatched: 0, running: 0, merged: 0, failed: 0, accepted: 0 };
                for (const item of entry.items) {
                  const s = resolveSuggestionStatus(item);
                  if (s in counts) counts[s as keyof typeof counts] += 1;
                }
                return counts;
              })() : null;
              const feedbackItems = entry.groupType === 'suggestion'
                ? entry.items
                    .map((item) => {
                      const message = suggestionFeedback[item.id];
                      if (!message) {
                        return null;
                      }

                      return {
                        id: item.id,
                        label: item.title || getFeedSuggestionDefaultTitle(item),
                        message,
                        tone: (
                          resolveSuggestionStatus(item) === 'failed'
                          || /failed|could not|timed out|invalid|must be provided|error|rolled back/i.test(message)
                        ) ? 'error' as const : 'success' as const,
                      };
                    })
                    .filter((value): value is {
                      id: string;
                      label: string;
                      message: string;
                      tone: 'error' | 'success';
                    } => value !== null)
                : undefined;

              if (entry.groupType === 'suggestion' && selectedFilter === 'suggestion') {
                const suggestionListItems = entry.items;
                const suggestionLanes = partitionSuggestionItemsByLifecycle(
                  suggestionListItems,
                  resolveSuggestionStatus,
                );
                const laneOrder: SuggestionLifecycleLane[] = ['pending', 'active', 'complete'];

                return (
                  <div
                    key={`suggestion-list:${entry.groupId}`}
                    data-testid="suggestion-list-view"
                    className="space-y-2 sm:space-y-3"
                  >
                    <section className="rounded-[1.45rem] border border-zinc-800/80 bg-zinc-950/85 px-3 py-2.5">
                      <div className="flex min-w-0 items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex min-w-0 items-center gap-2">
                            <h2 className="text-base font-semibold text-zinc-100">Suggested changes</h2>
                            <span className="rounded-full border border-zinc-700/80 bg-zinc-900/60 px-2 py-0.5 text-[11px] font-medium text-zinc-300">
                              {suggestionListItems.length}
                            </span>
                          </div>
                        </div>
                        <CompactInfoPopover title="How suggestions are organized" buttonLabel="View how suggestions are organized">
                          <p>Pending stays reviewable.</p>
                          <p>Dispatched and running suggestions move into Active and update live.</p>
                          <p>Merged, accepted, dismissed, and failed suggestions stay in Complete for history.</p>
                        </CompactInfoPopover>
                      </div>
                    </section>

                    <div className="space-y-3">
                      {laneOrder.map((lane) => {
                        const laneItems = suggestionLanes[lane];
                        const laneHasPendingAction = laneItems.some((item) => suggestionPendingActions[item.id] != null);
                        const lanePendingItems = laneItems.filter((item) => resolveSuggestionStatus(item) === 'pending');

                        return (
                          <SuggestionStatusLane
                            key={lane}
                            lane={lane}
                            items={laneItems}
                            resolveSuggestionStatus={resolveSuggestionStatus}
                            getSuggestionPendingAction={(item) => suggestionPendingActions[item.id] ?? null}
                            getSuggestionFeedback={(item) => suggestionFeedback[item.id] ?? null}
                            codeFixProgressMap={codeFixProgressMap}
                            creatorSessionTitles={suggestionCreatorSessionTitles}
                            batchActions={lane === 'pending' && lanePendingItems.length > 0
                              ? {
                                  acceptAll: {
                                    label: laneHasPendingAction ? 'Working...' : `Accept all (${lanePendingItems.length})`,
                                    disabled: laneHasPendingAction,
                                    onClick: () => handleFeedSuggestionBatchAccept(lanePendingItems),
                                  },
                                  dismissAll: {
                                    label: laneHasPendingAction ? 'Working...' : 'Dismiss all',
                                    disabled: laneHasPendingAction,
                                    onClick: () => handleFeedSuggestionBatchDismiss(lanePendingItems),
                                  },
                                }
                              : undefined}
                            onSuggestionAccept={handleFeedSuggestionAccept}
                            onSuggestionDismiss={handleFeedSuggestionDismiss}
                            onSuggestionChat={handleChatAboutSuggestion}
                            onSuggestionRetry={handleFeedSuggestionRetry}
                            onSuggestionCancel={handleFeedSuggestionCancel}
                          />
                        );
                      })}
                    </div>
                  </div>
                );
              }

              return (
                <AsyncGroupedItemsCard
                  key={`group:${entry.groupId}`}
                  groupId={entry.groupId}
                  groupType={entry.groupType}
                  title={entry.title}
                  items={entry.items}
                  previewItems={entry.previewItems}
                  itemCount={entry.items.length}
                  timestamp={entry.latestTimestamp}
                  statusCounts={statusCounts}
                  feedbackItems={feedbackItems}
                  resolveSuggestionStatus={entry.groupType === 'suggestion' ? resolveSuggestionStatus : undefined}
                  getSuggestionPendingAction={entry.groupType === 'suggestion'
                    ? ((item) => suggestionPendingActions[item.id] ?? null)
                    : undefined}
                  getSuggestionFeedback={entry.groupType === 'suggestion'
                    ? ((item) => suggestionFeedback[item.id] ?? null)
                    : undefined}
                  onSuggestionAccept={entry.groupType === 'suggestion' ? handleFeedSuggestionAccept : undefined}
                  onSuggestionDismiss={entry.groupType === 'suggestion' ? handleFeedSuggestionDismiss : undefined}
                  onOpenDetail={() => {
                    if (entry.groupType === 'suggestion') {
                      setSelectedFilter('suggestion');
                      return;
                    }

                    setGroupDetailEntry({
                      groupId: entry.groupId,
                      groupType: entry.groupType,
                      title: entry.title,
                      items: entry.items,
                    });
                  }}
                  chatAction={chatAction}
                  batchActions={batchActions}
                />
              );
            }

            if (entry.kind === 'analysis-series') {
              return (
                <AnalysisSeriesCard
                  key={`analysis-series:${entry.series.key}`}
                  entry={entry.series}
                  onOpenDetail={(itemId) => {
                    const detailItem = items.find((item) => item.id === itemId);
                    if (detailItem) {
                      openPostDetail(detailItem);
                    }
                  }}
                />
              );
            }

            if (entry.kind === 'thread-group') {
              return (
                <ThreadGroup
                  key={entry.groupId}
                  threadId={entry.threadId}
                  cycleId={entry.cycleId}
                  threadTitle={entry.threadTitle}
                  threadRationale={entry.threadRationale}
                  threadProminence={entry.threadProminence}
                  feedbackProbe={entry.feedbackProbe}
                  sourceItemIds={entry.sourceItemIds}
                  continuing={entry.continuing}
                  analysisItems={entry.analysisItems}
                  items={entry.items}
                  agentName={agentName}
                  onChat={handleChatAboutPost}
                  onOpenDetail={openPostDetail}
                  searchQuery={searchQuery}
                  onSubmitFeedback={submitThreadFeedback}
                />
              );
            }

            const { item } = entry;
            if (item.type === 'notification') {
              return (
                <NotificationCard
                  key={item.id}
                  item={item}
                  pendingAction={notificationPendingActions[item.id] ?? null}
                  feedback={notificationFeedback[item.id]}
                  onDismiss={handleNotificationDismiss}
                />
              );
            }

            if (item.type === 'suggestion') {
              const status = resolveSuggestionStatus(item);
              return (
                <SuggestionCard
                  key={item.id}
                  item={item}
                  status={status}
                  pendingAction={suggestionPendingActions[item.id] ?? null}
                  feedback={suggestionFeedback[item.id]}
                  codeFixProgress={codeFixProgressMap[item.id] ?? null}
                  creatorSessionTitles={suggestionCreatorSessionTitles}
                  onAccept={handleFeedSuggestionAccept}
                  onDismiss={handleFeedSuggestionDismiss}
                  onChatAboutSuggestion={handleChatAboutSuggestion}
                  onRetry={handleFeedSuggestionRetry}
                  onCancel={handleFeedSuggestionCancel}
                />
              );
            }

            return (
              <ContentCard
                key={item.id}
                item={item}
                agentName={agentName}
                onChat={handleChatAboutPost}
                onOpenDetail={openPostDetail}
                searchQuery={searchQuery}
              />
            );
          })}

          {isLoadingMore && <p className="py-4 text-center text-xs text-zinc-500">Loading more...</p>}
          <div ref={sentinelRef} className="h-2" />
        </section>
      </div>

      {!showConfigEditor && !showPreferencesPanel && !isChatDetailOpen && renderChatComposerPanel()}

      {groupDetailEntry && (
        <GroupDetailView
          groupId={groupDetailEntry.groupId}
          groupType={groupDetailEntry.groupType}
          title={groupDetailEntry.title}
          items={groupDetailEntry.items}
          onClose={() => setGroupDetailEntry(null)}
          resolveSuggestionStatus={resolveSuggestionStatus}
          suggestionPendingActions={suggestionPendingActions}
          suggestionFeedback={suggestionFeedback}
          codeFixProgressMap={codeFixProgressMap}
          creatorSessionTitles={suggestionCreatorSessionTitles}
          onSuggestionAccept={handleFeedSuggestionAccept}
          onSuggestionDismiss={handleFeedSuggestionDismiss}
          onSuggestionChat={handleChatAboutSuggestion}
          onSuggestionRetry={handleFeedSuggestionRetry}
          onSuggestionCancel={handleFeedSuggestionCancel}
          onSuggestionBatchAccept={handleFeedSuggestionBatchAccept}
          onSuggestionBatchDismiss={handleFeedSuggestionBatchDismiss}
          notificationPendingActions={notificationPendingActions}
          notificationFeedback={notificationFeedback}
          onNotificationDismiss={handleNotificationDismiss}
          searchQuery={searchQuery}
        />
      )}

      {detailStack.map((entry) => {
        if (entry.kind === 'post') {
          return (
            <PostDetailView
              key={entry.key}
              routeId={entry.routeId}
              mode="overlay"
              composerReservedHeight={baseComposerReservedHeight}
              agentName={agentName}
              backLabel="Back"
              onClose={closeTopDetailView}
              onResolvedItem={handleResolvedDetailPostItem}
              onChatAboutPost={handleChatAboutPostInDetail}
              onOpenDetail={openPostDetail}
              relatedConversations={conversationCards
                .filter((conversation) => conversation.contextKind === 'post' && conversation.contextRefId === entry.routeId)
                .map((conversation) => ({
                  id: conversation.sessionId,
                  title: conversation.title,
                  summary: conversation.summary,
                  status: conversationStatusLabel(conversation.status),
                  lastTimestamp: conversation.lastTimestamp,
                }))}
              onOpenConversation={(conversationId) => {
                const conversation = conversationCardMap[conversationId] ?? null;
                if (conversation) {
                  updateSelectedChatSession(conversation.sessionId);
                  setConversationScrollToBottomId(conversationId);
                }
                openConversationDetail(
                  conversationId,
                  conversation?.contextKind === 'post' ? conversation.contextRefId : null,
                );
              }}
              searchQuery={searchQuery}
            />
          );
        }

        if (entry.kind === 'group') {
          return null;
        }

        const conversation = entry.conversationId ? conversationCardMap[entry.conversationId] ?? null : null;
        const contextRouteId = conversation?.contextKind === 'post'
          ? conversation.contextRefId
          : entry.contextPostId;
        const detailSession = conversationSessions.find(
          (s) => s.sessionId === (conversation?.sessionId ?? entry.conversationId)
        ) ?? targetSessionSummary ?? null;
        const detailSessionTitle = detailSession?.title ?? DEFAULT_GENERAL_AGENT_SESSION_TITLE;
        const detailSessionTitleNode = renderChatSessionHeaderTitle(
          detailSession,
          detailSessionTitle,
        );
        const detailSessionWorkingDirectory = formatWorkingDirectoryLabel(
          detailSession?.workingDirectory ?? conversation?.workingDirectory ?? null,
        ) ?? undefined;
        const detailSessionSubtitle = renderChatSessionHeaderSubtitle(
          detailSession,
          detailSessionWorkingDirectory,
        );

        return (
          <PostDetailView
            key={entry.key}
            routeId={contextRouteId}
            mode="overlay"
            contentMode="chat"
            closeOnEscape={!chatSessionReasoningPopover && !chatSessionCompactPopover}
            composerReservedHeight={baseComposerReservedHeight}
            agentName={agentName}
            title={detailSessionTitleNode}
            subtitle={detailSessionSubtitle}
            headerActions={renderChatSessionHeaderActions(detailSession)}
            backLabel="Back"
            chatBody={(
              <ConversationDetail
                key={entry.key}
                conversation={conversation}
                agentName={agentName}
                curationTask={feedBannerCurationTask}
                visibleStreamingChat={visibleStreamingChat}
                retainedLiveActivity={conversation ? retainedLiveActivityBySession[conversation.sessionId] ?? null : null}
                lastChatActivityAt={lastChatActivityAt}
                chatProgress={effectiveChatProgress}
                orchestratorStatus={orchestratorStatus}
                onInlineCodeFixSuggestionDecision={(suggestion, decision) => {
                  void handleInlineCodeFixSuggestionDecision(suggestion, decision);
                }}
                resolveInlineCodeFixSuggestionStatus={resolveInlineCodeFixSuggestionStatus}
                suggestionPendingActions={suggestionPendingActions}
                suggestionFeedback={suggestionFeedback}
                onCancelTask={handleCancelOrchestratorTask}
                shouldScrollToBottom={conversation ? conversationScrollToBottomId === conversation.sessionId : false}
                onDidScrollToBottom={() => setConversationScrollToBottomId(null)}
                scrollToMessageId={conversation && conversationScrollToMessage?.sessionId === conversation.sessionId
                  ? conversationScrollToMessage.messageId
                  : null}
                onDidScrollToMessage={() => setConversationScrollToMessage(null)}
                layoutMode="detail"
                composerReservedHeight={chatDetailComposerReservedHeight}
                showCurationStatusWhenEmpty={!contextRouteId}
                detailEntryKey={entry.key}
                searchQuery={searchQuery}
                emptyState={contextRouteId
                  ? 'Use the composer below to start this post conversation.'
                  : 'Use the composer below to start a new conversation.'}
              />
            )}
            chatComposer={!showConfigEditor && !showPreferencesPanel ? renderChatComposerPanel('detail') : null}
            onClose={closeTopDetailView}
            onChatAboutPost={handleChatAboutPostInDetail}
            searchQuery={searchQuery}
          />
        );
      })}

      <CodeFixReasoningSwitcherModal
        open={isCodeFixReasoningModalOpen}
        provider={brainProviderInfo.provider}
        value={codeFixReasoningEffort}
        isSaving={isSavingCodeFixReasoning}
        error={codeFixReasoningError}
        onClose={() => {
          if (isSavingCodeFixReasoning) return;
          setIsCodeFixReasoningModalOpen(false);
          setCodeFixReasoningError(null);
        }}
        onSelect={(nextValue) => {
          if (nextValue === codeFixReasoningEffort) {
            setIsCodeFixReasoningModalOpen(false);
            return;
          }
          void (async () => {
            const ok = await setCodeFixReasoningEffort(nextValue);
            if (ok) {
              setIsCodeFixReasoningModalOpen(false);
            }
          })();
        }}
      />
      <BrainProviderSwitcherModal
        open={isBrainProviderModalOpen}
        status={brainProviderStatus}
        error={brainProviderStatusError}
        isLoading={isLoadingBrainProviderStatus}
        isSubmitting={isSwitchingBrainProvider}
        targetProvider={pendingBrainProvider}
        codexReasoningEffort={pendingCodexReasoningEffort}
        onClose={closeBrainProviderModal}
        onTargetProviderChange={setPendingBrainProvider}
        onCodexReasoningEffortChange={setPendingCodexReasoningEffort}
        onSubmit={() => void submitBrainProviderSwitch()}
      />
      <UsageSummaryModal
        isOpen={isUsageModalOpen}
        onClose={closeUsageModal}
        codexUsageLabel={usageSummaryLabels.codexUsageLabel}
        codexUsageResetLabel={usageSummaryLabels.codexUsageResetLabel}
        codexUsageTitle={usageSummaryLabels.codexUsageTitle}
        claudeUsageLabel={usageSummaryLabels.claudeUsageLabel}
      />
      <RenameSessionModal
        open={renameSessionId !== null}
        title={renameSessionTitle}
        error={renameSessionError}
        isSubmitting={isRenamingSession}
        onClose={closeRenameSessionModal}
        onSubmit={() => void renameSelectedChatSession()}
        onTitleChange={handleRenameSessionTitleChange}
      />
      <ConfigPanel open={showConfigEditor} onClose={() => setShowConfigEditor(false)} />
      <PreferencesPanel open={showPreferencesPanel} onClose={() => setShowPreferencesPanel(false)} />
    </main>
  );
}
