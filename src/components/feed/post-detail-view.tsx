'use client';

import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AnalysisSeriesCard } from '@/components/feed/analysis-series-card';
import {
  ContentCard,
  HackerNewsPointsIndicator,
  resolveHackerNewsPoints,
} from '@/components/feed/content-card';
import { buildAnalysisRenderableEntries } from '@/lib/analysis-presentation';
import { useOverlayDismiss } from '@/lib/overlay-dismiss';
import { createReconnectingWs } from '@/lib/reconnecting-ws';
import {
  buildSuggestionApplyRequest,
  getSuggestionApplySuccessMessage,
  readSuggestionActionErrorMessage,
  type SuggestionApplyResponse,
  wasSuggestionApplySuccessful,
} from '@/lib/feed-suggestions';
import { scrollSearchHighlightIntoView } from '@/lib/search-detail-scroll';
import { textMatchesSearchQuery } from '@/lib/search-utils';
import type { FeedItem, SuggestionStatus } from '@/types/feed';

interface PostResponse {
  item: FeedItem;
  children: FeedItem[];
}

interface ChildrenResponse {
  children?: FeedItem[];
}

interface PostEnrichmentResponse {
  agent?: { id?: string };
  alreadyRequested?: boolean;
  requestId?: string;
}

interface PostDetailViewProps {
  routeId?: string | null;
  mode?: 'page' | 'overlay';
  contentMode?: 'post' | 'chat';
  closeOnEscape?: boolean;
  composerReservedHeight?: number;
  agentName?: string;
  title?: ReactNode;
  subtitle?: ReactNode;
  headerActions?: ReactNode;
  backLabel?: string;
  chatBody?: ReactNode;
  chatComposer?: ReactNode;
  onClose: () => void;
  onResolvedItem?: (routeId: string, item: FeedItem | null) => void;
  onChatAboutPost?: (item: FeedItem, selectedText?: string) => void;
  onOpenDetail?: (item: FeedItem) => void;
  relatedConversations?: Array<{
    id: string;
    title: string;
    summary: string;
    status: string;
    lastTimestamp: string;
  }>;
  onOpenConversation?: (conversationId: string) => void;
  searchQuery?: string | null;
}

const relationshipRank: Record<string, number> = {
  parent: 1,
  child: 2,
  reply: 3,
  analysis: 4,
  related: 5,
  thread: 6,
};

function createWsUrl(pathname: '/ws/feed') {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${pathname}`;
}

function sortChildren(items: FeedItem[]): FeedItem[] {
  return [...items].sort((left, right) => {
    const leftRank = relationshipRank[left.relationship || ''] ?? 99;
    const rightRank = relationshipRank[right.relationship || ''] ?? 99;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return left.publishedAt.localeCompare(right.publishedAt);
  });
}

function sortByPublishedAtAsc(items: FeedItem[]): FeedItem[] {
  return [...items].sort((left, right) => left.publishedAt.localeCompare(right.publishedAt));
}

function getFeedItemSearchText(item: FeedItem): string {
  return [item.title, item.text, item.excerpt, item.reason].filter(Boolean).join(' ');
}

function feedItemMatchesSearch(item: FeedItem, searchQuery: string | null): boolean {
  if (!searchQuery) {
    return false;
  }

  return textMatchesSearchQuery(getFeedItemSearchText(item), searchQuery);
}

export function shouldShowThreadAncestors(item: FeedItem | null): boolean {
  if (!item) return false;
  return Boolean(item.metadata?.inReplyToStatusId || item.metadata?.conversationId);
}

function mergeChildren(current: FeedItem[], incoming: FeedItem[]): FeedItem[] {
  const map = new Map<string, FeedItem>();
  for (const item of current) map.set(item.id, item);
  for (const item of incoming) map.set(item.id, item);
  return sortChildren(Array.from(map.values()));
}

export function didEnrichmentAddChildren(previousChildren: FeedItem[], nextChildren: FeedItem[]): boolean {
  const previousIds = new Set(previousChildren.map((entry) => entry.id));
  return nextChildren.some((entry) => !previousIds.has(entry.id));
}

function applyFullEnrichmentRequestState(
  item: FeedItem | null,
  input: { requestId?: string },
): FeedItem | null {
  if (!item || !input.requestId) return item;

  return {
    ...item,
    metadata: {
      ...(item.metadata ?? {}),
      fullEnrichmentRequestId: input.requestId,
    },
  };
}

export function shouldShowPostDetailEnrichButton({
  item,
  isChatMode,
  isLoading,
}: {
  item: FeedItem | null;
  isChatMode: boolean;
  isLoading: boolean;
}): boolean {
  return !isChatMode && !isLoading && Boolean(item?.id);
}

function formatBackLabel(): string {
  return 'Back';
}

function formatElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}:${remaining.toString().padStart(2, '0')}`;
}

function formatRelativeTimeShort(dateIso: string): string {
  const value = new Date(dateIso);
  if (Number.isNaN(value.getTime())) return 'unknown';
  const diffSeconds = Math.round((Date.now() - value.getTime()) / 1000);
  if (diffSeconds < 60) return `${diffSeconds}s ago`;
  if (diffSeconds < 3600) return `${Math.floor(diffSeconds / 60)}m ago`;
  if (diffSeconds < 86400) return `${Math.floor(diffSeconds / 3600)}h ago`;
  return `${Math.floor(diffSeconds / 86400)}d ago`;
}

function formatPossessive(name: string): string {
  return name.endsWith('s') ? `${name}'` : `${name}'s`;
}

const detailContentContainerClass = 'mx-auto w-full max-w-3xl px-0 sm:px-2';
const detailHeaderClass = 'sticky top-0 z-20 border-b border-zinc-800/80 bg-black/95 pt-[max(env(safe-area-inset-top),0.25rem)] backdrop-blur';
const detailOverlayClass = 'fixed inset-0 z-[45] flex items-stretch justify-center bg-black/70 backdrop-blur-[2px]';
const DETAIL_MIN_BOTTOM_PADDING_PX = 176;
const CHAT_HEADER_BACK_LABEL_MIN_ROW_WIDTH = 360;
const detailSheetClass = 'relative z-10 h-full w-full overflow-y-auto overscroll-contain bg-black pb-44 text-zinc-100 shadow-2xl sm:mx-auto sm:max-w-3xl sm:border-x sm:border-zinc-800';
const detailChatSheetClass = 'relative z-10 flex h-full w-full flex-col overflow-hidden overscroll-contain bg-black text-zinc-100 shadow-2xl sm:mx-auto sm:max-w-3xl sm:border-x sm:border-zinc-800';

export function resolveDetailBottomPadding(composerReservedHeight?: number): number {
  return Math.max(composerReservedHeight ?? 0, DETAIL_MIN_BOTTOM_PADDING_PX);
}

type ConversationEntryKind = 'ancestor' | 'main' | 'continuation' | 'other';

function getConversationEntryKind(entry: FeedItem, mainPostId: string | null): ConversationEntryKind {
  if (entry.id === mainPostId) return 'main';
  if (entry.relationship === 'parent' || entry.relationship === 'thread') return 'ancestor';
  if (entry.relationship === 'child') return 'continuation';
  return 'other';
}

export function shouldRenderConversationConnector(
  entry: FeedItem,
  nextEntry: FeedItem | undefined,
  mainPostId: string | null,
): boolean {
  if (!nextEntry || !mainPostId) return false;

  const currentKind = getConversationEntryKind(entry, mainPostId);
  const nextKind = getConversationEntryKind(nextEntry, mainPostId);

  if (currentKind === 'ancestor') {
    return nextKind === 'ancestor' || nextKind === 'main';
  }

  if (currentKind === 'main') {
    return false;
  }

  if (currentKind === 'continuation') {
    return nextKind === 'continuation';
  }

  return false;
}

export function buildConversationPosts({
  threadAncestors,
  parentPosts,
  item,
  continuationPosts,
}: {
  threadAncestors: FeedItem[];
  parentPosts: FeedItem[];
  item: FeedItem | null;
  continuationPosts: FeedItem[];
}): FeedItem[] {
  const sequence = [...threadAncestors, ...parentPosts, item, ...continuationPosts]
    .filter((entry): entry is FeedItem => Boolean(entry));
  const seen = new Set<string>();
  return sequence.filter((entry) => {
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  });
}

function renderConnectedConversation(
  items: FeedItem[],
  mainPostId: string,
  agentName: string,
  onChatAboutPost?: (item: FeedItem, selectedText?: string) => void,
  onOpenDetail?: (item: FeedItem) => void,
  searchQuery?: string | null,
  suggestionOptions?: {
    status: SuggestionStatus;
    pendingAction: 'accept' | 'dismiss' | null;
    feedback: string | null;
    onAccept: (item: FeedItem) => void | Promise<void>;
    onDismiss: (item: FeedItem) => void | Promise<void>;
  },
) {
  return items.map((entry, index) => {
    const isMainPost = entry.id === mainPostId;
    const nextEntry = items[index + 1];
    const shouldRenderConnector = shouldRenderConversationConnector(entry, nextEntry, mainPostId);

    return (
      <div key={entry.id} className="relative pl-1">
        {shouldRenderConnector && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute bottom-[-10px] left-[42px] top-[62px] w-0.5 bg-zinc-500 sm:left-[44px] sm:top-[66px]"
            style={{ width: '2px' }}
          />
        )}
        <div className={isMainPost ? 'pb-1' : ''}>
          <ContentCard
            item={entry}
            detail
            detailLayout={isMainPost ? 'full-width' : 'card'}
            articleLayout={entry.type === 'analysis'}
            agentName={agentName}
            onChat={onChatAboutPost}
            onOpenDetail={onOpenDetail}
            detailMainItemId={mainPostId}
            searchQuery={searchQuery}
            useSearchSnippet={false}
            suggestionStatus={suggestionOptions?.status}
            suggestionPendingAction={suggestionOptions?.pendingAction}
            suggestionFeedback={suggestionOptions?.feedback}
            onSuggestionAccept={suggestionOptions?.onAccept}
            onSuggestionDismiss={suggestionOptions?.onDismiss}
          />
        </div>
      </div>
    );
  });
}

export function PostDetailView({
  routeId,
  mode = 'page',
  contentMode = 'post',
  closeOnEscape = true,
  composerReservedHeight,
  agentName: agentNameProp,
  title,
  subtitle,
  headerActions,
  backLabel,
  chatBody,
  chatComposer,
  onClose,
  onResolvedItem,
  onChatAboutPost,
  onOpenDetail,
  relatedConversations = [],
  onOpenConversation,
  searchQuery = null,
}: PostDetailViewProps) {
  const shouldLoadPost = Boolean(routeId);
  const isChatMode = contentMode === 'chat';
  const detailBottomPadding = resolveDetailBottomPadding(composerReservedHeight);
  const { backdropProps } = useOverlayDismiss({
    enabled: mode === 'overlay',
    onClose,
    policy: 'detail',
    closeOnEscape,
  });
  const [item, setItem] = useState<FeedItem | null>(null);
  const [children, setChildren] = useState<FeedItem[]>([]);
  const [isLoading, setIsLoading] = useState(shouldLoadPost);
  const [isEnriching, setIsEnriching] = useState(false);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [enrichmentOutcome, setEnrichmentOutcome] = useState<'idle' | 'empty' | 'updated'>('idle');
  const [enrichmentStartedAt, setEnrichmentStartedAt] = useState<number | null>(null);
  const [enrichmentElapsedSeconds, setEnrichmentElapsedSeconds] = useState(0);
  const [configContent, setConfigContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [suggestionStatusOverride, setSuggestionStatusOverride] = useState<SuggestionStatus | null>(null);
  const [suggestionPendingAction, setSuggestionPendingAction] = useState<'accept' | 'dismiss' | null>(null);
  const [suggestionFeedback, setSuggestionFeedback] = useState<string | null>(null);
  const [showBackLabel, setShowBackLabel] = useState(false);
  const chatHeaderRowRef = useRef<HTMLDivElement>(null);
  const detailRootRef = useRef<HTMLElement | null>(null);
  const childrenRef = useRef<FeedItem[]>([]);
  const enrichmentBaselineChildrenRef = useRef<FeedItem[]>([]);
  const activeEnrichmentRunRef = useRef(0);
  const enrichmentRequestInFlightRef = useRef(false);
  const currentItemId = item?.id ?? null;
  const normalizedSearchQuery = searchQuery?.trim() || null;
  const hasDetailSearchMatch = useMemo(() => {
    if (isChatMode || !normalizedSearchQuery) {
      return false;
    }

    return [item, ...children]
      .filter((entry): entry is FeedItem => Boolean(entry))
      .some((entry) => feedItemMatchesSearch(entry, normalizedSearchQuery));
  }, [children, isChatMode, item, normalizedSearchQuery]);

  useEffect(() => {
    childrenRef.current = children;
  }, [children]);

  useLayoutEffect(() => {
    if (!isChatMode) return;

    const row = chatHeaderRowRef.current;
    if (!row) return;

    const updateBackLabelMode = () => {
      const nextShowBackLabel = row.getBoundingClientRect().width >= CHAT_HEADER_BACK_LABEL_MIN_ROW_WIDTH;
      setShowBackLabel((current) => (current === nextShowBackLabel ? current : nextShowBackLabel));
    };

    updateBackLabelMode();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateBackLabelMode);
      return () => window.removeEventListener('resize', updateBackLabelMode);
    }

    const observer = new ResizeObserver(updateBackLabelMode);
    observer.observe(row);
    return () => observer.disconnect();
  }, [isChatMode]);

  useEffect(() => {
    let cancelled = false;

    async function loadPost() {
      if (!routeId) {
        if (!cancelled) {
          setItem(null);
          setChildren([]);
          setError(null);
          setIsLoading(false);
        }
        return;
      }

      setIsLoading(true);
      setError(null);

      try {
        const response = await fetch(`/api/feed/${encodeURIComponent(routeId)}`);
        if (response.status === 404) {
          if (!cancelled) setError('Post not found');
          return;
        }
        if (!response.ok) throw new Error(`Error ${response.status}`);

        const data = await response.json() as PostResponse;
        if (!cancelled) {
          setItem(data.item);
          setChildren(sortChildren(data.children || []));
        }

        try {
          const childrenResponse = await fetch(`/api/feed/${encodeURIComponent(routeId)}/children`, {
            cache: 'no-store',
          });
          if (childrenResponse.ok) {
            const childrenPayload = await childrenResponse.json() as ChildrenResponse;
            if (!cancelled) {
              setChildren(sortChildren(childrenPayload.children || []));
            }
          }
        } catch {
          // Keep the initial detail payload if the child refresh fails.
        }
      } catch {
        if (!cancelled) {
          setError('Failed to load post');
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void loadPost();

    return () => {
      cancelled = true;
    };
  }, [routeId]);

  useEffect(() => {
    if (agentNameProp) return;

    let cancelled = false;

    const loadConfig = async () => {
      try {
        const response = await fetch('/api/config', { cache: 'no-store' });
        if (!response.ok) throw new Error(`Error ${response.status}`);
        const payload = await response.json() as { content?: string };
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
  }, [agentNameProp]);

  useEffect(() => {
    if (!item?.id) return;
    activeEnrichmentRunRef.current += 1;
    enrichmentRequestInFlightRef.current = false;
    setIsEnriching(false);
    setAgentId(null);
    setEnrichmentOutcome('idle');
    setEnrichmentStartedAt(null);
    setEnrichmentElapsedSeconds(0);
    setSuggestionStatusOverride(null);
    setSuggestionPendingAction(null);
    setSuggestionFeedback(null);
    enrichmentBaselineChildrenRef.current = [];
  }, [item?.id]);

  useEffect(() => {
    if (!routeId || !onResolvedItem) return;
    onResolvedItem(routeId, item);
    return () => {
      onResolvedItem(routeId, null);
    };
  }, [item, onResolvedItem, routeId]);

  const startEnrichment = useCallback(async (enrichmentKey: string) => {
    if (isChatMode || !routeId || enrichmentRequestInFlightRef.current) return;

    const runId = activeEnrichmentRunRef.current + 1;
    activeEnrichmentRunRef.current = runId;
    enrichmentRequestInFlightRef.current = true;

    const isCurrentRun = () => activeEnrichmentRunRef.current === runId;
    const clearEnrichmentState = () => {
      setIsEnriching(false);
      setEnrichmentStartedAt(null);
      enrichmentBaselineChildrenRef.current = [];
      window.sessionStorage.removeItem(enrichmentKey);
    };

    const startedAt = Date.now();
    enrichmentBaselineChildrenRef.current = childrenRef.current;
    window.sessionStorage.setItem(enrichmentKey, new Date(startedAt).toISOString());
    setIsEnriching(true);
    setEnrichmentOutcome('idle');
    setEnrichmentStartedAt(startedAt);
    setEnrichmentElapsedSeconds(0);

    try {
      const response = await fetch(`/api/feed/${encodeURIComponent(routeId)}/enrich`, {
        method: 'POST',
      });

      if (!response.ok) {
        throw new Error(`Error ${response.status}`);
      }

      const body = await response.json() as PostEnrichmentResponse;
      if (!isCurrentRun()) return;

      if (body.requestId || body.agent?.id) {
        setItem((current) => applyFullEnrichmentRequestState(current, {
          requestId: body.requestId ?? body.agent?.id,
        }));
      }

      if (body.agent?.id) {
        setAgentId(body.agent.id);
      } else {
        clearEnrichmentState();
      }
    } catch {
      if (isCurrentRun()) {
        clearEnrichmentState();
      }
    } finally {
      if (isCurrentRun()) {
        enrichmentRequestInFlightRef.current = false;
      }
    }
  }, [isChatMode, routeId]);

  const handleEnrichClick = useCallback(() => {
    if (!currentItemId) return;
    void startEnrichment(`evogent-post-enrich:${currentItemId}`);
  }, [currentItemId, startEnrichment]);

  useEffect(() => {
    return () => {
      activeEnrichmentRunRef.current += 1;
      enrichmentRequestInFlightRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (isChatMode || !agentId || !routeId) return;

    let cancelled = false;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}`);
        if (!response.ok) {
          if (!cancelled) {
            setIsEnriching(false);
            setAgentId(null);
            setEnrichmentStartedAt(null);
            enrichmentBaselineChildrenRef.current = [];
          }
          return;
        }

        const body = await response.json() as { agent?: { status?: string } };
        if (!cancelled && body.agent && body.agent.status !== 'running') {
          setIsEnriching(false);
          setAgentId(null);
          setEnrichmentStartedAt(null);

          try {
            const childrenResponse = await fetch(`/api/feed/${encodeURIComponent(routeId)}/children`, {
              cache: 'no-store',
            });
            if (!childrenResponse.ok) return;
            const childrenPayload = await childrenResponse.json() as ChildrenResponse;
            if (!cancelled) {
              const nextChildren = sortChildren(childrenPayload.children || []);
              setChildren(nextChildren);
              setEnrichmentOutcome(
                didEnrichmentAddChildren(enrichmentBaselineChildrenRef.current, nextChildren)
                  ? 'updated'
                  : 'empty',
              );
              enrichmentBaselineChildrenRef.current = [];
            }
          } catch {
            // Ignore refresh failures after enrichment completes.
          }
        }
      } catch {
        if (!cancelled) {
          setIsEnriching(false);
          setAgentId(null);
          setEnrichmentStartedAt(null);
          enrichmentBaselineChildrenRef.current = [];
        }
      }
    }, 3000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [agentId, isChatMode, routeId]);

  useEffect(() => {
    if (!isEnriching || enrichmentStartedAt === null) {
      setEnrichmentElapsedSeconds(0);
      return;
    }

    const updateElapsed = () => {
      const elapsed = Math.max(0, Math.floor((Date.now() - enrichmentStartedAt) / 1000));
      if (elapsed >= 10 * 60) {
        setIsEnriching(false);
        setAgentId(null);
        setEnrichmentStartedAt(null);
        setEnrichmentElapsedSeconds(0);
        enrichmentBaselineChildrenRef.current = [];
        return;
      }
      setEnrichmentElapsedSeconds(elapsed);
    };

    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [isEnriching, enrichmentStartedAt]);

  useEffect(() => {
    if (isChatMode || !item?.id) return;
    if (isEnriching) return;

    const enrichmentKey = `evogent-post-enrich:${item.id}`;
    if (window.sessionStorage.getItem(enrichmentKey)) {
      window.sessionStorage.removeItem(enrichmentKey);
    }
  }, [isChatMode, isEnriching, item?.id]);

  useEffect(() => {
    if (isChatMode || !item?.id) return;

    const dispose = createReconnectingWs(createWsUrl('/ws/feed'), (event) => {
      try {
        const payload = JSON.parse(event.data) as { type?: string; items?: FeedItem[] };
        if (payload.type !== 'feed_update' || !Array.isArray(payload.items) || payload.items.length === 0) {
          return;
        }

        const incomingRoot = payload.items.find((entry) => entry.id === item.id);
        if (incomingRoot) {
          setItem(incomingRoot);
        }

        const incomingChildren = payload.items.filter((entry) => entry.parentId === item.id);
        if (incomingChildren.length > 0) {
          setChildren((current) => mergeChildren(current, incomingChildren));
        }
      } catch {
        // Ignore malformed websocket messages.
      }
    });

    return dispose;
  }, [isChatMode, item?.id]);

  useEffect(() => {
    if (mode !== 'overlay') return;

    const previousBodyOverflow = document.body.style.overflow;
    const previousHtmlOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousHtmlOverflow;
    };
  }, [mode]);

  useEffect(() => {
    if (isChatMode || isLoading || !normalizedSearchQuery || !hasDetailSearchMatch) {
      return;
    }

    const root = detailRootRef.current;
    if (!root) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      scrollSearchHighlightIntoView(root);
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [children, currentItemId, hasDetailSearchMatch, isChatMode, isLoading, normalizedSearchQuery]);

  const derivedAgentName = useMemo(() => {
    if (agentNameProp) return agentNameProp;
    if (!configContent) return 'Agent';
    const match = configContent.match(/(?:^|\n)##\s+Agent Name\s*\n([^\n]+)/i);
    const resolvedName = match?.[1]?.trim();
    return resolvedName || 'Agent';
  }, [agentNameProp, configContent]);

  const threadAncestors = useMemo(() => {
    if (!shouldShowThreadAncestors(item)) return [];
    return sortByPublishedAtAsc(children.filter((entry) => entry.relationship === 'thread'));
  }, [children, item]);
  const parentPosts = useMemo(
    () => sortByPublishedAtAsc(children.filter((entry) => entry.relationship === 'parent')),
    [children],
  );
  const continuationPosts = useMemo(
    () => sortByPublishedAtAsc(children.filter((entry) => entry.relationship === 'child')),
    [children],
  );
  const replies = useMemo(
    () => sortByPublishedAtAsc(children.filter((entry) => entry.relationship === 'reply')),
    [children],
  );
  const analyses = useMemo(
    () => children.filter((entry) => entry.relationship === 'analysis'),
    [children],
  );
  const analysisEntries = useMemo(
    () => buildAnalysisRenderableEntries(analyses),
    [analyses],
  );
  const relatedPosts = useMemo(
    () => children.filter((entry) => entry.relationship === 'related'),
    [children],
  );
  const conversationPosts = useMemo(
    () => buildConversationPosts({ threadAncestors, parentPosts, item, continuationPosts }),
    [continuationPosts, item, parentPosts, threadAncestors],
  );
  const showNoAdditionalContext = !isEnriching && enrichmentOutcome === 'empty';
  const showEnrichButton = shouldShowPostDetailEnrichButton({ item, isChatMode, isLoading });
  const detailHeaderHackerNewsPoints = !isChatMode ? resolveHackerNewsPoints(item) : null;
  const resolvedSuggestionStatus = item?.type === 'suggestion'
    ? suggestionStatusOverride ?? item.suggestionStatus ?? 'pending'
    : 'pending';

  const handleSuggestionAccept = useCallback(async (suggestion: FeedItem) => {
    if (suggestion.type !== 'suggestion') return;
    if (suggestionPendingAction) return;

    setSuggestionFeedback(null);
    setSuggestionPendingAction('accept');

    try {
      const applyRequest = buildSuggestionApplyRequest(suggestion);
      const applyResponse = await fetch('/api/suggestions/batch-accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(applyRequest),
      });

      if (!applyResponse.ok) {
        throw new Error(await readSuggestionActionErrorMessage(
          applyResponse,
          `Failed to apply suggestion (${applyResponse.status}).`,
        ));
      }

      const applyResult = await applyResponse.json() as SuggestionApplyResponse;
      const nextStatus = applyResult.suggestionStatus ?? 'dispatched';

      if (!wasSuggestionApplySuccessful(applyResult)) {
        if (nextStatus) {
          setSuggestionStatusOverride(nextStatus);
        }
        setSuggestionFeedback(applyResult.message || 'Could not dispatch the dev agent.');
        return;
      }

      setSuggestionStatusOverride(nextStatus);
      setSuggestionFeedback(getSuggestionApplySuccessMessage(applyResult));
    } catch (error) {
      setSuggestionFeedback(
        error instanceof Error && error.message.trim()
          ? error.message
          : 'Failed to apply suggestion.',
      );
    } finally {
      setSuggestionPendingAction(null);
    }
  }, [suggestionPendingAction]);

  const handleSuggestionDismiss = useCallback(async (suggestion: FeedItem) => {
    if (suggestion.type !== 'suggestion') return;
    if (suggestionPendingAction) return;

    const previousStatus = resolvedSuggestionStatus;
    setSuggestionPendingAction('dismiss');
    setSuggestionStatusOverride('dismissed');

    try {
      const response = await fetch('/api/interactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          feedItemId: suggestion.id,
          action: 'dismiss_suggestion',
        }),
      });

      if (!response.ok) {
        throw new Error(`Error ${response.status}`);
      }

      setSuggestionFeedback(previousStatus === 'accepted' ? 'Suggestion hidden from the feed.' : null);
    } catch {
      setSuggestionStatusOverride(previousStatus);
      setSuggestionFeedback('Failed to dismiss suggestion.');
    } finally {
      setSuggestionPendingAction(null);
    }
  }, [resolvedSuggestionStatus, suggestionPendingAction]);

  const renderContent = useCallback(() => {
    const header = (
      <div data-testid="post-detail-header" className={detailHeaderClass}>
        {isChatMode ? (
          <div ref={chatHeaderRowRef} className={`${detailContentContainerClass} flex items-center gap-2 px-1 pt-1 pb-1.5 sm:gap-3 sm:px-2 sm:py-2`}>
            <button
              type="button"
              data-testid="post-back-button"
              className={`inline-flex h-11 shrink-0 items-center justify-center rounded-full border border-zinc-700 bg-zinc-950 text-sm font-medium text-zinc-100 transition-colors hover:bg-zinc-900 ${showBackLabel ? 'w-auto gap-2 px-4 sm:text-base' : 'w-11'}`}
              onClick={onClose}
              aria-label={backLabel || formatBackLabel()}
            >
              <span aria-hidden="true" className={`leading-none ${showBackLabel ? 'text-lg' : 'text-xl'}`}>←</span>
              {showBackLabel && <span>{backLabel || formatBackLabel()}</span>}
            </button>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center justify-between gap-2" data-curator-actions-row="">
                {(title || subtitle) && (
                  <div className="min-w-0 pt-0.5">
                    {title && (
                      typeof title === 'string' ? (
                        <p className="truncate text-sm font-semibold text-zinc-100">{title}</p>
                      ) : (
                        <div className="min-w-0">{title}</div>
                      )
                    )}
                  </div>
                )}
                {(detailHeaderHackerNewsPoints || headerActions) ? (
                  <div className="flex shrink-0 items-center gap-1 sm:gap-2">
                    <HackerNewsPointsIndicator points={detailHeaderHackerNewsPoints} compact />
                    {headerActions}
                  </div>
                ) : null}
              </div>
              {subtitle && (
                typeof subtitle === 'string' ? (
                  <p className="mt-0.5 truncate text-xs text-zinc-500">{subtitle}</p>
                ) : (
                  <div className="mt-0.5 min-w-0">{subtitle}</div>
                )
              )}
            </div>
          </div>
        ) : (
          <div className={`${detailContentContainerClass} flex flex-wrap items-center justify-between gap-3 pt-1 pb-1.5 sm:flex-nowrap sm:py-2`}>
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <button
                type="button"
                data-testid="post-back-button"
                className="inline-flex min-h-11 items-center gap-2 rounded-full border border-zinc-700 bg-zinc-950 px-4 text-sm font-medium text-zinc-100 transition-colors hover:bg-zinc-900 sm:text-base"
                onClick={onClose}
              >
                <span aria-hidden="true" className="text-base leading-none sm:text-lg">←</span>
                <span>{backLabel || formatBackLabel()}</span>
              </button>
              {(title || subtitle) && (
                <div className="min-w-0">
                  {title && (
                    typeof title === 'string' ? (
                      <p className="truncate text-sm font-semibold text-zinc-100">{title}</p>
                    ) : (
                      <div className="min-w-0">{title}</div>
                    )
                  )}
                  {subtitle && (
                    typeof subtitle === 'string' ? (
                      <p className="truncate text-xs text-zinc-500">{subtitle}</p>
                    ) : (
                      <div className="mt-0.5 min-w-0">{subtitle}</div>
                    )
                  )}
                </div>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <HackerNewsPointsIndicator points={detailHeaderHackerNewsPoints} compact />
              {headerActions}
            </div>
          </div>
        )}
      </div>
    );

    if (isLoading) {
      return (
        <>
          {header}
          <div className={`${detailContentContainerClass} py-3 sm:py-4`}>
            <div className="min-h-[40vh]" />
          </div>
        </>
      );
    }

    if (isChatMode) {
      return (
        <>
          {header}
          <div className={`${detailContentContainerClass} flex min-h-0 flex-1 flex-col gap-3 py-3 sm:py-4`}>
            {item && (
              <section data-testid="chat-context-section" className="shrink-0">
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2">
                  <div className="flex items-center gap-2 text-xs text-zinc-400">
                    <span className="font-semibold uppercase tracking-wide text-zinc-500">Discussing</span>
                    <span className="truncate font-medium text-zinc-200">
                      {item.title || item.text?.substring(0, 120) || 'Untitled post'}
                    </span>
                    <span className="ml-auto shrink-0 text-[11px] text-zinc-500">{item.type}</span>
                  </div>
                </div>
              </section>
            )}

            {!item && error && (
              <div className="shrink-0 rounded-xl border border-zinc-800 bg-zinc-950 p-4">
                <p className="text-sm text-zinc-400">{error}</p>
              </div>
            )}

            <section data-testid="chat-conversation-section" className="flex min-h-0 flex-1 flex-col space-y-2">
              {chatBody}
            </section>

            {chatComposer && (
              <div className="shrink-0">
                {chatComposer}
              </div>
            )}
          </div>
        </>
      );
    }

    if (!item || error) {
      return (
        <>
          {header}
          <div className={`${detailContentContainerClass} py-3 sm:py-4`}>
            <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
              <p className="text-sm text-zinc-400">{error || 'Post unavailable'}</p>
            </div>
          </div>
        </>
      );
    }

    const detailMainItemId = item.id;

    return (
      <>
        {header}
        <div data-print-detail-content className={`${detailContentContainerClass} space-y-3 py-3 sm:py-4`}>
          {conversationPosts.length > 1 ? (
            <section data-testid="post-thread-section" className="space-y-2">
              <h1 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Conversation</h1>
              {renderConnectedConversation(
                conversationPosts,
                item.id,
                derivedAgentName,
                onChatAboutPost,
                onOpenDetail,
                searchQuery,
                {
                  status: resolvedSuggestionStatus,
                  pendingAction: suggestionPendingAction,
                  feedback: suggestionFeedback,
                  onAccept: handleSuggestionAccept,
                  onDismiss: handleSuggestionDismiss,
                },
              )}
            </section>
          ) : (
            <section data-testid="post-main-section" className="space-y-2">
              <h1 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Post</h1>
              <ContentCard
                item={item}
                detail
                detailLayout="full-width"
                articleLayout={item.type === 'analysis'}
                agentName={derivedAgentName}
                onChat={onChatAboutPost}
                onOpenDetail={onOpenDetail}
                detailMainItemId={detailMainItemId}
                suggestionStatus={resolvedSuggestionStatus}
                suggestionPendingAction={suggestionPendingAction}
                suggestionFeedback={suggestionFeedback}
                searchQuery={searchQuery}
                useSearchSnippet={false}
                onSuggestionAccept={handleSuggestionAccept}
                onSuggestionDismiss={handleSuggestionDismiss}
              />
            </section>
          )}

          {showEnrichButton && (
            <div className="px-4 sm:px-5">
              <button
                type="button"
                data-testid="post-detail-enrich-button"
                className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-zinc-700 bg-zinc-950 px-4 py-2.5 text-sm font-medium text-zinc-100 transition-colors hover:bg-zinc-900 disabled:cursor-wait disabled:opacity-70 sm:w-auto"
                onClick={handleEnrichClick}
                disabled={isEnriching}
              >
                {isEnriching && (
                  <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-zinc-300 border-r-transparent" aria-hidden />
                )}
                <span>{isEnriching ? 'Enriching...' : 'Curate Additional Context'}</span>
              </button>
            </div>
          )}

          {isEnriching && (
            <div data-testid="enrichment-banner" className="rounded-xl border border-amber-800/60 bg-amber-900/20 px-3 py-2 text-sm text-amber-200">
              <div className="flex items-center gap-2">
                <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-amber-300 border-r-transparent" aria-hidden />
                <span>Loading more context in the background... {formatElapsed(enrichmentElapsedSeconds)}</span>
              </div>
            </div>
          )}

          {showNoAdditionalContext && (
            <div data-testid="enrichment-empty-banner" className="rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-300">
              No additional context found.
            </div>
          )}

          {replies.length > 0 && (
            <section data-testid="post-replies-section" className="space-y-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Replies</h2>
              {replies.map((entry) => (
                <ContentCard
                  key={entry.id}
                  item={entry}
                  detail
                  agentName={derivedAgentName}
                  onChat={onChatAboutPost}
                  onOpenDetail={onOpenDetail}
                  detailMainItemId={detailMainItemId}
                  searchQuery={searchQuery}
                  useSearchSnippet={false}
                />
              ))}
            </section>
          )}

          {analysisEntries.length > 0 && (
            <section data-testid="post-analysis-section" className="space-y-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{formatPossessive(derivedAgentName)} analysis</h2>
              {analysisEntries.map((entry) => (
                entry.kind === 'item' ? (
                  <ContentCard
                    key={entry.item.id}
                    item={entry.item}
                    detail
                    agentName={derivedAgentName}
                    onChat={onChatAboutPost}
                    onOpenDetail={onOpenDetail}
                    detailMainItemId={detailMainItemId}
                    searchQuery={searchQuery}
                    useSearchSnippet={false}
                  />
                ) : (
                  <AnalysisSeriesCard
                    key={entry.key}
                    entry={entry}
                    onOpenDetail={(itemId) => {
                      const detailItem = analyses.find((analysis) => analysis.id === itemId);
                      if (detailItem) {
                        onOpenDetail?.(detailItem);
                      }
                    }}
                  />
                )
              ))}
            </section>
          )}

          {relatedPosts.length > 0 && (
            <section data-testid="post-related-section" className="space-y-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Related context</h2>
              {relatedPosts.map((entry) => (
                <ContentCard
                  key={entry.id}
                  item={entry}
                  detail
                  agentName={derivedAgentName}
                  onChat={onChatAboutPost}
                  onOpenDetail={onOpenDetail}
                  detailMainItemId={detailMainItemId}
                  searchQuery={searchQuery}
                  useSearchSnippet={false}
                />
              ))}
            </section>
          )}

          {relatedConversations.length > 0 && (
            <section data-testid="post-related-conversations-section" className="space-y-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Related conversations</h2>
              {relatedConversations.map((conversation) => (
                <button
                  key={conversation.id}
                  type="button"
                  onClick={() => onOpenConversation?.(conversation.id)}
                  className="w-full rounded-2xl border border-zinc-800 bg-zinc-950/80 px-4 py-3 text-left hover:bg-zinc-900"
                >
                  <div className="flex items-center gap-2">
                    <p className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-100">{conversation.title}</p>
                    <span className="rounded-full border border-zinc-700 bg-black/30 px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] text-zinc-300">
                      {conversation.status}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs leading-5 text-zinc-400">{conversation.summary}</p>
                  <p className="mt-2 text-[11px] text-zinc-500">{formatRelativeTimeShort(conversation.lastTimestamp)}</p>
                </button>
              ))}
            </section>
          )}
        </div>
      </>
    );
  }, [
    analyses,
    analysisEntries,
    conversationPosts,
    derivedAgentName,
    detailHeaderHackerNewsPoints,
    enrichmentElapsedSeconds,
    error,
    handleEnrichClick,
    isEnriching,
    isLoading,
    item,
    headerActions,
    onChatAboutPost,
    onOpenDetail,
    onClose,
    onOpenConversation,
    backLabel,
    chatBody,
    chatComposer,
    isChatMode,
    relatedPosts,
    relatedConversations,
    replies,
    showBackLabel,
    showEnrichButton,
    showNoAdditionalContext,
    resolvedSuggestionStatus,
    searchQuery,
    suggestionFeedback,
    suggestionPendingAction,
    subtitle,
    title,
    handleSuggestionAccept,
    handleSuggestionDismiss,
  ]);

  if (mode === 'overlay') {
    return (
      <div
        data-testid="post-detail-overlay"
        data-print-detail-overlay
        className={detailOverlayClass}
      >
        <div
          aria-hidden="true"
          className="absolute inset-0 touch-none"
          {...backdropProps}
        />
        <div
          ref={(node) => {
            detailRootRef.current = node;
          }}
          data-testid="post-detail-sheet"
          data-search-detail-root=""
          data-print-detail-sheet
          className={isChatMode ? detailChatSheetClass : detailSheetClass}
          style={isChatMode ? undefined : { paddingBottom: `${detailBottomPadding}px` }}
        >
          {renderContent()}
        </div>
      </div>
    );
  }

  return (
    <main
      ref={(node) => {
        detailRootRef.current = node;
      }}
      data-testid="post-detail-page"
      data-search-detail-root=""
      className="min-h-screen bg-black pb-44 text-zinc-100"
      style={isChatMode ? undefined : { paddingBottom: `${detailBottomPadding}px` }}
    >
      {renderContent()}
    </main>
  );
}
