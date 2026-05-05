'use client';

import { Children, cloneElement, isValidElement, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { createPortal } from 'react-dom';
import { TextSelectionTooltip } from '@/components/feed/text-selection-tooltip';
import {
  formatCompactCount as formatNumber,
  formatRelativeTimestamp as formatRelativeTime,
  InitialsAvatar as Avatar,
} from '@/components/feed/tweet-card-primitives';
import {
  getFeedSuggestionAcceptLabel,
  getFeedSuggestionDefaultTitle,
  getFeedSuggestionLabel,
  getSuggestionStatusFeedback,
  getSuggestionStatusLabel,
  isSuggestionActionable,
  isCodeFixSuggestion,
} from '@/lib/feed-suggestions';
import type { ChildPreview, FeedItem, LinkCard, LinkPreview, MediaItem, Poll, QuoteTweet, SuggestionStatus, TweetCommunityNote } from '@/types/feed';
import { getFeedMediaItems, getMediaThumbnailUrl, getPreferredFeedMediaItems } from '@/lib/feed-media';
import {
  stripLeadingReplyMentions,
  stripLinkPreviewUrlsForDisplay,
  stripQuotedTweetUrlsForDisplay,
  stripTrailingTweetMediaUrls,
  truncateTextForCollapsedDisplay,
} from '@/lib/tweet-text';
import { getFeedItemBatchEnrichmentState, isAwaitingFullEnrichmentMetrics } from '@/lib/feed-enrichment-state';
import { isProminentFeedItem } from '@/lib/feed-prominence';
import { getYouTubeFeedData, isYouTubeSource, type YouTubeFeedData } from '@/lib/youtube-feed';
import { resolveHackerNewsDiscussionUrl } from '@/lib/hacker-news';
import { buildSearchSnippet, splitSearchHighlightParts, textMatchesSearchQuery } from '@/lib/search-utils';

interface ContentCardProps {
  item: FeedItem;
  detail?: boolean;
  articleLayout?: boolean;
  detailLayout?: 'card' | 'full-width';
  agentName?: string;
  hideFeedbackActions?: boolean;
  onChat?: (item: FeedItem, selectedText?: string) => void;
  onOpenDetail?: (item: FeedItem) => void;
  detailMainItemId?: string | null;
  suppressedChildPreviewIds?: string[];
  suggestionStatus?: SuggestionStatus;
  suggestionPendingAction?: 'accept' | 'dismiss' | null;
  suggestionFeedback?: string | null;
  searchQuery?: string | null;
  useSearchSnippet?: boolean;
  onSuggestionAccept?: (item: FeedItem) => void | Promise<void>;
  onSuggestionDismiss?: (item: FeedItem) => void | Promise<void>;
}

const fullWidthDetailCardClass = 'group relative w-full px-4 py-2 sm:px-5';
const detailReplyChildCardClass = 'group relative w-full px-4 py-3 sm:px-5';
const defaultContentCardClass = 'group relative w-full rounded-2xl border border-zinc-700 bg-zinc-950/90 p-4 shadow-[0_12px_36px_rgba(0,0,0,0.18)] transition-[background-color,border-color,box-shadow] hover:border-zinc-600 hover:bg-zinc-950 hover:shadow-[0_18px_44px_rgba(0,0,0,0.24)]';

export function resolveContentCardOuterClass({
  detailLayout = 'card',
  relationship,
  detailMainItemId,
}: {
  detailLayout?: ContentCardProps['detailLayout'];
  relationship: FeedItem['relationship'];
  detailMainItemId?: string | null;
}): string {
  const isFullWidthDetail = detailLayout === 'full-width';
  const isDetailReplyChild = relationship === 'reply' && Boolean(detailMainItemId);

  return isFullWidthDetail
    ? fullWidthDetailCardClass
    : isDetailReplyChild
      ? detailReplyChildCardClass
      : defaultContentCardClass;
}

function resolvePostRouteId(item: FeedItem): string {
  return item.id;
}

function labelForRelationship(relationship: string): string {
  switch (relationship.toLowerCase()) {
    case 'analysis':
      return 'Analysis';
    case 'related':
      return 'Related';
    case 'reply':
      return 'Reply';
    case 'child':
      return 'Context';
    case 'thread':
      return 'Thread';
    case 'parent':
      return 'Parent';
    default:
      return 'Context';
  }
}

function previewLineText(child: ChildPreview): string {
  const title = child.title?.trim();
  if (title) return title;
  let text = child.text;
  if (child.relationship === 'reply') {
    text = stripLeadingReplyMentions(text);
  }
  if (text.length <= 80) return text;
  return `${text.slice(0, 80).trimEnd()}...`;
}

function getChildPreviewSearchText(child: ChildPreview): string {
  return [child.title, child.text].filter(Boolean).join(' ');
}

function getChildPreviewTimestamp(child: ChildPreview): string {
  return child.publishedAt || '';
}

function sortChildPreviewsForSearch(previews: ChildPreview[], searchQuery: string | null | undefined): ChildPreview[] {
  if (!searchQuery) {
    return previews;
  }

  const matchCache = new Map<string, boolean>();
  const isMatch = (child: ChildPreview) => {
    const cached = matchCache.get(child.id);
    if (cached !== undefined) {
      return cached;
    }
    const matches = textMatchesSearchQuery(getChildPreviewSearchText(child), searchQuery);
    matchCache.set(child.id, matches);
    return matches;
  };

  if (!previews.some(isMatch)) {
    return previews;
  }

  return [...previews].sort((left, right) => {
    const leftMatches = isMatch(left);
    const rightMatches = isMatch(right);
    if (leftMatches !== rightMatches) {
      return leftMatches ? -1 : 1;
    }
    if (leftMatches && rightMatches) {
      const byTimestamp = getChildPreviewTimestamp(right).localeCompare(getChildPreviewTimestamp(left));
      if (byTimestamp !== 0) {
        return byTimestamp;
      }
    }
    return 0;
  });
}

export function shouldRenderContentCardChildPreviews({
  itemId,
  detailMainItemId,
  hasChildPreviews,
}: {
  itemId: string;
  detailMainItemId?: string | null;
  hasChildPreviews: boolean;
}): boolean {
  return hasChildPreviews && itemId !== detailMainItemId;
}

export function shouldRenderContentCardParentTweetPreview(
  parentTweet: FeedItem | null,
  detailMainItemId?: string | null,
): boolean {
  return Boolean(parentTweet && parentTweet.id !== detailMainItemId);
}

const TEXT_CHAR_LIMIT_MAIN = 280;
const TEXT_LINE_LIMIT_MAIN = 6;
const TEXT_CHAR_LIMIT_CHILD = 200;
const TEXT_LINE_LIMIT_CHILD = 4;
const MAIN_TEXT_TRUNCATION = { charLimit: TEXT_CHAR_LIMIT_MAIN, lineLimit: TEXT_LINE_LIMIT_MAIN } as const;
const CHILD_TEXT_TRUNCATION = { charLimit: TEXT_CHAR_LIMIT_CHILD, lineLimit: TEXT_LINE_LIMIT_CHILD } as const;
const EXPAND_LABEL = 'More';
const COLLAPSE_LABEL = 'Less';
const CHILD_ANALYSIS_EXPAND_LABEL = 'Read full article';
const CHILD_ANALYSIS_COLLAPSE_LABEL = 'Collapse article';
const CHILD_ANALYSIS_BODY_CLASS_NAME = 'max-w-none text-[15px] leading-[1.55] text-zinc-200 [&_p]:my-3 [&_p]:text-[15px] [&_p]:leading-[1.55] [&_ul]:my-3 [&_ol]:my-3 [&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-5 [&_ol]:pl-5 [&_li]:my-1 [&_li]:text-[15px] [&_li]:leading-[1.55] [&_li]:marker:text-zinc-500 [&_strong]:font-semibold [&_strong]:text-zinc-100 [&_em]:text-zinc-100 [&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-zinc-700 [&_blockquote]:pl-4 [&_blockquote]:text-zinc-300 [&_blockquote_p]:my-3 [&_blockquote_p]:text-[15px] [&_blockquote_p]:leading-[1.55] [&_h1]:mt-6 [&_h1]:text-[22px] [&_h1]:font-bold [&_h1]:leading-tight [&_h2]:mt-5 [&_h2]:text-[19px] [&_h2]:font-semibold [&_h2]:leading-tight [&_h3]:mt-4 [&_h3]:text-[17px] [&_h3]:font-semibold [&_h3]:leading-tight [&_h4]:mt-3 [&_h4]:text-[15px] [&_h4]:font-semibold [&_h4]:leading-tight [&_h1:first-child]:mt-0 [&_h2:first-child]:mt-0 [&_h3:first-child]:mt-0 [&_h4:first-child]:mt-0';

interface SourceAvatarProfile {
  initials: string;
  displayName: string;
  avatarClassName: string;
}

const sourceAvatarMap: Record<string, SourceAvatarProfile> = {
  bbc: { initials: 'BB', displayName: 'BBC News', avatarClassName: 'bg-red-600 text-white' },
  reuters: { initials: 'RE', displayName: 'Reuters', avatarClassName: 'bg-orange-500 text-white' },
  aljazeera: { initials: 'AJ', displayName: 'Al Jazeera', avatarClassName: 'bg-amber-500 text-zinc-950' },
  guardian: { initials: 'GU', displayName: 'Guardian', avatarClassName: 'bg-blue-600 text-white' },
  nytimes: { initials: 'NY', displayName: 'NYTimes', avatarClassName: 'bg-zinc-500 text-white' },
  wsj: { initials: 'WS', displayName: 'WSJ', avatarClassName: 'bg-amber-800 text-white' },
  techcrunch: { initials: 'TC', displayName: 'TechCrunch', avatarClassName: 'bg-green-600 text-white' },
  ars: { initials: 'AR', displayName: 'Ars Technica', avatarClassName: 'bg-orange-600 text-white' },
  npr: { initials: 'NP', displayName: 'NPR', avatarClassName: 'bg-blue-700 text-white' },
  substack: { initials: 'SB', displayName: 'Substack', avatarClassName: 'bg-orange-500 text-white' },
  youtube: { initials: 'YT', displayName: 'YouTube', avatarClassName: 'bg-red-600 text-white' },
  web: { initials: 'WE', displayName: 'Web', avatarClassName: 'bg-zinc-600 text-white' },
  claude: { initials: 'AG', displayName: 'Agent', avatarClassName: 'bg-violet-600 text-white' },
  evogent: { initials: 'AG', displayName: 'Agent', avatarClassName: 'bg-violet-600 text-white' },
};

const sourceAliasMap: Record<string, string> = {
  x: 'twitter',
  hn: 'hackernews',
  theguardian: 'guardian',
  nyt: 'nytimes',
  newyorktimes: 'nytimes',
  wallstreetjournal: 'wsj',
  arstechnica: 'ars',
  evogent: 'evogent',
  mediaagnt: 'evogent',
  evogentapp: 'evogent',
  claudeai: 'claude',
};
const legacyAgentSourceHyphen = ['media', 'agent'].join('-');
const legacyAgentSourceCompact = ['media', 'agent'].join('');
const legacyAgentSourceUnderscore = ['media', 'agent'].join('_');
sourceAliasMap[legacyAgentSourceHyphen] = 'evogent';
sourceAliasMap[legacyAgentSourceCompact] = 'evogent';
sourceAliasMap[legacyAgentSourceUnderscore] = 'evogent';

function isAgentCreatedSource(source: string | null | undefined): boolean {
  const normalized = source?.trim().toLowerCase() ?? '';
  return normalized === 'claude'
    || normalized === 'evogent'
    || normalized === legacyAgentSourceHyphen
    || normalized === legacyAgentSourceCompact
    || normalized === legacyAgentSourceUnderscore;
}

interface LinkPart {
  type: 'text' | 'url' | 'mention' | 'hashtag';
  content: string;
  href?: string;
}

const DUAL_TIMESTAMP_THRESHOLD_MS = 5 * 60 * 1000;
const ENRICHMENT_COMPLETE_VISIBILITY_MS = 3_000;
type CardEnrichmentIndicatorState = 'hidden' | 'enriching' | 'complete' | 'failed' | 'incomplete';

function formatFeedTimestamp(item: Pick<FeedItem, 'publishedAt' | 'createdAt' | 'source' | 'type'>): string {
  const publishedDelta = formatRelativeTime(item.publishedAt);
  const createdDelta = formatRelativeTime(item.createdAt);
  const isAgentCreatedContent = isAgentCreatedSource(item.source) || item.type === 'analysis';

  if (isAgentCreatedContent) {
    return createdDelta;
  }

  const publishedTime = new Date(item.publishedAt).getTime();
  const createdTime = new Date(item.createdAt).getTime();
  if (Number.isNaN(publishedTime) || Number.isNaN(createdTime)) return publishedDelta;

  if (Math.abs(publishedTime - createdTime) < DUAL_TIMESTAMP_THRESHOLD_MS) {
    return publishedDelta;
  }

  return `${publishedDelta} / ${createdDelta}`;
}

function formatAbsoluteTimestamp(dateIso: string): string {
  const value = new Date(dateIso);
  if (Number.isNaN(value.getTime())) return 'Unknown time';

  return value.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function CompactEnrichmentIndicator({
  state,
}: {
  state: CardEnrichmentIndicatorState;
}) {
  if (state === 'hidden') {
    return null;
  }

  if (state === 'complete') {
    return (
      <span
        title="Enrichment complete"
        aria-label="Enrichment complete"
        className="inline-flex h-4 w-4 items-center justify-center text-[11px] font-semibold text-emerald-400"
      >
        ✓
      </span>
    );
  }

  if (state === 'failed' || state === 'incomplete') {
    const label = state === 'failed' ? 'Enrichment failed' : 'Enrichment incomplete';

    return (
      <span
        className="inline-flex h-4 w-4 items-center justify-center text-[11px] font-semibold text-amber-300"
        title={label}
        aria-label={label}
        data-testid="content-card-enrichment-indicator"
      >
        !
      </span>
    );
  }

  return (
    <span
      className="inline-flex h-4 w-4 items-center justify-center"
      title="Enriching (loading replies and metrics)..."
      aria-label="Enriching (loading replies and metrics)..."
      data-testid="content-card-enrichment-indicator"
    >
      <span className="inline-block h-3 w-3 animate-spin rounded-full border border-amber-300/80 border-r-transparent" />
    </span>
  );
}

function formatYouTubeScheduledLabel(video: Pick<YouTubeFeedData, 'scheduledStartAt' | 'scheduledStartText'>): string | null {
  if (video.scheduledStartAt) {
    const value = new Date(video.scheduledStartAt);
    if (!Number.isNaN(value.getTime())) {
      return value.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
    }
  }

  const rawLabel = video.scheduledStartText?.trim();
  if (!rawLabel) {
    return null;
  }

  return rawLabel.replace(/^(scheduled\s+for|premieres?\s+(?:on|in)?|streaming\s+on)\s+/i, '').trim();
}

export function resolveYouTubeViewLabel(video: Pick<YouTubeFeedData, 'viewCount' | 'viewCountText'>): string | null {
  const viewCountText = video.viewCountText?.trim();
  if (viewCountText) {
    return viewCountText;
  }

  if (typeof video.viewCount === 'number' && Number.isFinite(video.viewCount) && video.viewCount >= 0) {
    return `${formatNumber(Math.floor(video.viewCount))} views`;
  }

  return null;
}

function readMetadataString(metadata: FeedItem['metadata'], key: string): string | null {
  if (!metadata || typeof metadata !== 'object') {
    return null;
  }

  const record = metadata as Record<string, unknown>;
  const directValue = typeof record[key] === 'string' ? record[key].trim() : '';
  if (directValue) {
    return directValue;
  }

  const article = record.article && typeof record.article === 'object' && !Array.isArray(record.article)
    ? record.article as Record<string, unknown>
    : null;
  const articleValue = typeof article?.[key] === 'string' ? article[key].trim() : '';
  return articleValue || null;
}

function readPositiveInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const normalized = Math.floor(value);
    return normalized > 0 ? normalized : null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim().replace(/,/g, '');
    if (/^\d+$/.test(trimmed)) {
      const parsed = Number.parseInt(trimmed, 10);
      return parsed > 0 ? parsed : null;
    }
  }

  return null;
}

function readMetadataRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function isHackerNewsFeedItem(item: Pick<FeedItem, 'source'>): boolean {
  return normalizeSourceKey(item.source) === 'hackernews';
}

export function resolveHackerNewsPoints(
  item: Pick<FeedItem, 'source' | 'metrics' | 'metadata'> | null | undefined,
): number | null {
  if (!item || !isHackerNewsFeedItem(item)) {
    return null;
  }

  const metricScore = readPositiveInteger(item.metrics.likes);
  if (metricScore) {
    return metricScore;
  }

  const metadata = readMetadataRecord(item.metadata);
  const hackerNewsMetadata = readMetadataRecord(metadata?.hackerNews)
    ?? readMetadataRecord(metadata?.hackernews);
  return readPositiveInteger(hackerNewsMetadata?.score)
    ?? readPositiveInteger(metadata?.hnScore)
    ?? readPositiveInteger(metadata?.score);
}

export function HackerNewsPointsIndicator({
  points,
  className,
  compact = false,
}: {
  points: number | null;
  className?: string;
  compact?: boolean;
}) {
  if (!points || points <= 0) {
    return null;
  }

  const pointLabel = points === 1 ? 'point' : 'points';
  const displayLabel = `${formatNumber(points)} pts`;

  return (
    <span
      data-testid="hacker-news-points"
      aria-label={`Hacker News score: ${points} ${pointLabel}`}
      title={`Hacker News score: ${points} ${pointLabel}`}
      className={`inline-flex min-w-0 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full border border-orange-500/30 bg-orange-500/10 font-medium text-orange-200 ${compact ? 'min-h-9 px-2 text-[11px] sm:min-h-10 sm:text-xs' : 'min-h-[44px] px-2 text-[12px] sm:px-2.5 sm:text-[13px]'} ${className || ''}`}
    >
      <span className="inline-flex h-5 min-w-5 items-center justify-center rounded bg-orange-500 px-1 text-[10px] font-bold leading-none text-zinc-950">
        HN
      </span>
      <span className="leading-none">{displayLabel}</span>
    </span>
  );
}

export function resolveSourceDisplayLabel(source: string | null | undefined): string {
  switch (normalizeSourceKey(source)) {
    case 'twitter':
      return 'X';
    case 'hackernews':
      return 'Hacker News';
    case 'youtube':
      return 'YouTube';
    case 'substack':
      return 'Substack';
    default:
      return fallbackSourceName(source);
  }
}

export function resolveSourceOpenLabel(source: string | null | undefined): string {
  switch (normalizeSourceKey(source)) {
    case 'twitter':
      return 'Open on X';
    case 'hackernews':
      return 'Open on HN';
    case 'youtube':
      return 'Open on YouTube';
    case 'substack':
      return 'Open on Substack';
    default:
      return 'Open link';
  }
}

export function resolveSecondarySourceLink(
  item: Pick<FeedItem, 'source' | 'sourceId' | 'url' | 'metadata'>,
): { href: string; label: string } | null {
  if (normalizeSourceKey(item.source) !== 'hackernews') {
    return null;
  }

  const hnUrl = resolveHackerNewsDiscussionUrl(item);
  if (!hnUrl || hnUrl === item.url) {
    return null;
  }

  return {
    href: hnUrl,
    label: 'HN Discussion',
  };
}

export function resolveOgDescriptionSubtitle(
  metadata: FeedItem['metadata'],
  displayText: string | null,
): string | null {
  const description = readMetadataString(metadata, 'ogDescription');
  const trimmedText = displayText?.trim() ?? '';
  if (!description || !trimmedText || trimmedText.length >= 100 || description === trimmedText) {
    return null;
  }

  return description;
}

function formatUrlForDisplay(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.replace(/^www\./, '')}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function stripRepeatedLead(text: string, lead: string | null | undefined): string {
  const trimmedText = text.trim();
  const trimmedLead = lead?.trim();
  if (!trimmedText || !trimmedLead) {
    return trimmedText;
  }

  if (trimmedText === trimmedLead) {
    return '';
  }

  if (trimmedText.startsWith(`${trimmedLead}\n`)) {
    return trimmedText.slice(trimmedLead.length).trim();
  }

  if (trimmedText.startsWith(`${trimmedLead} - `) || trimmedText.startsWith(`${trimmedLead}: `)) {
    return trimmedText.slice(trimmedLead.length + 3).trim();
  }

  return trimmedText;
}

type TextTruncationLimits = {
  charLimit: number;
  lineLimit: number;
};

function getTruncationState(
  text: string | null,
  isExpanded: boolean,
  { charLimit, lineLimit }: TextTruncationLimits = MAIN_TEXT_TRUNCATION,
) {
  const textLen = text?.length ?? 0;
  const lineCount = text ? text.split('\n').length : 0;
  const needsTruncation = textLen > charLimit || lineCount > lineLimit;

  if (!needsTruncation || isExpanded || !text) {
    return { needsTruncation, displayText: text };
  }

  return {
    needsTruncation,
    displayText: truncateTextForCollapsedDisplay(text, {
      charLimit,
      lineLimit,
    }),
  };
}

function normalizeSourceKey(source: string | null | undefined): string {
  const normalized = (source || '').toLowerCase().trim().replace(/[^a-z0-9]/g, '');
  return sourceAliasMap[normalized] || normalized;
}

function fallbackSourceInitials(source: string | null | undefined): string {
  const cleaned = (source || '').replace(/[^a-zA-Z0-9]/g, '');
  if (!cleaned) return 'WE';
  return cleaned.slice(0, 2).toUpperCase();
}

function fallbackSourceName(source: string | null | undefined): string {
  const trimmed = source?.trim();
  if (!trimmed) return 'Web';
  return trimmed;
}

function resolveNameInitials(name: string): string {
  const initials = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token[0]?.toUpperCase() ?? '')
    .join('')
    .slice(0, 2);
  return initials || 'AG';
}

function normalizeAgentName(name: string | null | undefined): string {
  const trimmed = name?.trim();
  return trimmed || 'Agent';
}

function resolveAgentSourceProfile(agentName: string): SourceAvatarProfile {
  const normalizedName = normalizeAgentName(agentName);
  return {
    initials: resolveNameInitials(normalizedName),
    displayName: normalizedName,
    avatarClassName: 'bg-violet-600 text-white',
  };
}

function formatPossessive(name: string): string {
  return name.endsWith('s') ? `${name}'` : `${name}'s`;
}

function resolveSourceAvatarProfile(source: string | null | undefined, agentName = 'Agent'): SourceAvatarProfile {
  const normalized = normalizeSourceKey(source);
  if (normalized === 'claude' || normalized === 'evogent' || normalized === 'research') {
    return resolveAgentSourceProfile(agentName);
  }
  const mapped = sourceAvatarMap[normalized];
  if (mapped) return mapped;

  return {
    initials: fallbackSourceInitials(source),
    displayName: fallbackSourceName(source),
    avatarClassName: 'bg-zinc-600 text-white',
  };
}

function resolveArticleAvatarUrl(item: Pick<FeedItem, 'authorAvatarUrl' | 'url'>): string | null {
  const authorAvatarUrl = item.authorAvatarUrl?.trim();
  if (authorAvatarUrl) return authorAvatarUrl;

  const articleUrl = item.url?.trim();
  if (!articleUrl) return null;

  try {
    const hostname = new URL(articleUrl).hostname;
    if (!hostname) return null;
    return `https://www.google.com/s2/favicons?domain=${hostname}&sz=128`;
  } catch {
    return null;
  }
}

export function resolveArticleHeaderDisplayName(
  item: Pick<FeedItem, 'authorDisplayName' | 'metadata'>,
  sourceProfile: Pick<SourceAvatarProfile, 'displayName'>,
): string {
  const authorDisplayName = item.authorDisplayName?.trim();
  if (authorDisplayName) {
    return authorDisplayName;
  }

  const metadataAuthorName = readMetadataString(item.metadata, 'authorName') ?? '';
  if (metadataAuthorName) {
    return metadataAuthorName;
  }

  return sourceProfile.displayName;
}

function trimUrlPunctuation(value: string): { url: string; trailing: string } {
  const match = value.match(/^(.*?)([),.!?:;]+)$/);
  if (!match) return { url: value, trailing: '' };
  return { url: match[1], trailing: match[2] };
}

function toTweetLinkPreview(card: LinkCard): LinkPreview | null {
  if (!card.url) {
    return null;
  }

  return {
    url: card.url,
    title: card.title,
    domain: card.domain,
    ...(card.imageUrl ? { image: card.imageUrl } : {}),
    ...(card.imageAlt ? { imageAlt: card.imageAlt } : {}),
    ...(card.description ? { description: card.description } : {}),
  };
}

export function getTweetLinkPreviews(item: FeedItem): LinkPreview[] {
  const linkPreviews = new Map<string, LinkPreview>();
  for (const preview of item.metadata?.linkPreviews ?? []) {
    const url = preview.url.trim();
    if (!url || linkPreviews.has(url)) {
      continue;
    }
    linkPreviews.set(url, {
      ...preview,
      url,
    });
  }
  if (linkPreviews.size > 0) {
    return Array.from(linkPreviews.values());
  }

  const fallback = item.metadata?.linkCard ? toTweetLinkPreview(item.metadata.linkCard) : null;
  return fallback ? [fallback] : [];
}

function getAnalysisSourcePreviews(item: FeedItem): LinkPreview[] {
  const sources = new Map<string, LinkPreview>();
  const pushSource = (source: LinkPreview | null) => {
    if (!source) return;

    const url = source.url.trim();
    if (!url) return;

    const fallbackLabel = formatUrlForDisplay(url);
    const title = source.title.trim() || fallbackLabel;
    const domain = source.domain.trim() || fallbackLabel;

    sources.set(url, {
      url,
      title,
      domain,
      ...(source.image ? { image: source.image } : {}),
      ...(source.description ? { description: source.description } : {}),
    });
  };

  for (const preview of item.metadata?.linkPreviews ?? []) {
    pushSource(preview);
  }

  pushSource(item.metadata?.linkCard ? toTweetLinkPreview(item.metadata.linkCard) : null);

  const fallbackUrl = item.url?.trim();
  if (fallbackUrl && !sources.has(fallbackUrl)) {
    let domain = formatUrlForDisplay(fallbackUrl);
    try {
      domain = new URL(fallbackUrl).hostname.replace(/^www\./, '');
    } catch {
      // Keep the formatted URL fallback.
    }

    pushSource({
      url: fallbackUrl,
      title: item.title?.trim() || formatUrlForDisplay(fallbackUrl),
      domain,
    });
  }

  return Array.from(sources.values());
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function buildPrintableSourcesHtml(sources: LinkPreview[]): string {
  if (sources.length === 0) {
    return '';
  }

  const items = sources.map((source) => {
    const label = escapeHtml(source.title || formatUrlForDisplay(source.url));
    const url = escapeHtml(source.url);
    const domain = source.domain.trim() ? `<span class="source-domain">${escapeHtml(source.domain)}</span>` : '';

    return `<li><a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>${domain}</li>`;
  }).join('');

  return `<section class="sources"><h2>Sources</h2><ul>${items}</ul></section>`;
}

function buildPrintableDocument({
  title,
  bodyHtml,
  sources,
}: {
  title: string;
  bodyHtml: string;
  sources: LinkPreview[];
}): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      @page {
        margin: 1in;
      }

      html {
        color-scheme: light;
      }

      body {
        margin: 0;
        background: #ffffff;
        color: #111827;
        font-family: Georgia, "Times New Roman", serif;
        font-size: 13pt;
        line-height: 1.65;
      }

      main {
        width: 100%;
      }

      h1 {
        margin: 0 0 0.35in;
        color: #111827;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 24pt;
        line-height: 1.2;
      }

      h2,
      h3,
      h4,
      h5,
      h6 {
        color: #111827;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        line-height: 1.3;
        page-break-after: avoid;
      }

      h2 {
        margin: 0.45in 0 0.16in;
        font-size: 18pt;
      }

      h3,
      h4 {
        margin: 0.3in 0 0.12in;
        font-size: 14pt;
      }

      p,
      li,
      blockquote p {
        margin: 0 0 0.16in;
        font-size: 13pt;
        line-height: 1.65;
      }

      ul,
      ol {
        margin: 0 0 0.2in 1.4em;
        padding: 0;
      }

      li + li {
        margin-top: 0.06in;
      }

      a {
        color: #111827;
        text-decoration: underline;
        text-decoration-color: #6b7280;
      }

      strong {
        color: #111827;
      }

      blockquote {
        margin: 0.25in 0;
        padding-left: 0.2in;
        border-left: 3px solid #d4d4d8;
        color: #3f3f46;
      }

      code,
      pre {
        font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
      }

      pre {
        overflow-x: auto;
        white-space: pre-wrap;
      }

      img,
      svg,
      video,
      canvas {
        max-width: 100%;
      }

      .sources {
        margin-top: 0.45in;
        padding-top: 0.22in;
        border-top: 1px solid #d4d4d8;
      }

      .sources h2 {
        margin-top: 0;
        color: #52525b;
        font-size: 10pt;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .sources ul {
        margin: 0.18in 0 0;
        list-style: none;
      }

      .sources li {
        margin: 0 0 0.14in;
      }

      .source-domain {
        margin-left: 0.12in;
        color: #52525b;
        font-size: 11pt;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <div class="analysis-body">${bodyHtml}</div>
      ${buildPrintableSourcesHtml(sources)}
    </main>
    <script>
      (() => {
        const closeAfterPrint = () => {
          window.removeEventListener('afterprint', closeAfterPrint);
          window.setTimeout(() => window.close(), 0);
        };

        const triggerPrint = () => {
          window.addEventListener('afterprint', closeAfterPrint, { once: true });
          window.focus();
          window.setTimeout(() => window.print(), 50);
        };

        const onLoad = () => {
          if (document.fonts?.ready) {
            document.fonts.ready.then(triggerPrint).catch(triggerPrint);
            return;
          }

          triggerPrint();
        };

        window.addEventListener('load', onLoad, { once: true });
      })();
    </script>
  </body>
</html>`;
}

function writePrintableDocument(targetWindow: Window, html: string) {
  targetWindow.document.open();
  targetWindow.document.write(html);
  targetWindow.document.close();
}

function printDocumentWithIframe(html: string) {
  if (typeof document === 'undefined') {
    return;
  }

  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.position = 'fixed';
  iframe.style.right = '0';
  iframe.style.bottom = '0';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = '0';

  document.body.appendChild(iframe);

  const cleanup = () => {
    iframe.remove();
  };

  const frameWindow = iframe.contentWindow;
  if (!frameWindow) {
    cleanup();
    return;
  }

  frameWindow.addEventListener('afterprint', cleanup, { once: true });
  writePrintableDocument(frameWindow, html);
}

function linkifyText(text: string): LinkPart[] {
  const result: LinkPart[] = [];
  const pattern = /(https?:\/\/[^\s]+|@[A-Za-z0-9_]{1,15}|#[A-Za-z0-9_]+)/g;

  let lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const token = match[0];
    const index = match.index ?? 0;

    if (index > lastIndex) {
      result.push({ type: 'text', content: text.slice(lastIndex, index) });
    }

    if (token.startsWith('http')) {
      const { url, trailing } = trimUrlPunctuation(token);
      result.push({ type: 'url', content: url, href: url });
      if (trailing) {
        result.push({ type: 'text', content: trailing });
      }
    } else if (token.startsWith('@')) {
      result.push({
        type: 'mention',
        content: token,
        href: `https://x.com/${token.slice(1)}`,
      });
    } else {
      result.push({
        type: 'hashtag',
        content: token,
        href: `https://x.com/hashtag/${encodeURIComponent(token.slice(1))}`,
      });
    }

    lastIndex = index + token.length;
  }

  if (lastIndex < text.length) {
    result.push({ type: 'text', content: text.slice(lastIndex) });
  }

  return result;
}

interface ResilientImageProps {
  src?: string | null;
  alt: string;
  className: string;
  loading?: 'eager' | 'lazy';
  fallbackClassName?: string;
}

function ResilientImage({
  src,
  alt,
  className,
  loading = 'lazy',
  fallbackClassName = 'bg-zinc-800',
}: ResilientImageProps) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  if (!src || failedSrc === src) {
    return <div aria-hidden="true" className={`${className} ${fallbackClassName}`} />;
  }

  return (
    <img
      src={src}
      alt={alt}
      className={className}
      loading={loading}
      onError={() => setFailedSrc(src)}
    />
  );
}

const LIGHTBOX_MIN_SCALE = 1;
const LIGHTBOX_MAX_SCALE = 4;
const LIGHTBOX_DOUBLE_TAP_MS = 300;
const LIGHTBOX_SWIPE_CLOSE_THRESHOLD = 120;
const LIGHTBOX_CLOSE_TRANSITION_MS = 180;

function clampValue(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function touchDistance(touches: React.TouchList): number {
  if (touches.length < 2) return 0;
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.hypot(dx, dy);
}

function ImageLightbox({
  imageUrl,
  isOpen,
  onRequestClose,
}: {
  imageUrl: string | null;
  isOpen: boolean;
  onRequestClose: () => void;
}) {
  const [scale, setScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const [swipeOffsetY, setSwipeOffsetY] = useState(0);
  const [isInteracting, setIsInteracting] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const lastTapAtRef = useRef(0);
  const panRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);
  const pinchRef = useRef<{ startDistance: number; startScale: number; originX: number; originY: number } | null>(null);
  const swipeRef = useRef<{ startX: number; startY: number; deltaX: number; deltaY: number } | null>(null);

  const clampTranslate = useCallback((nextScale: number, nextX: number, nextY: number) => {
    const container = containerRef.current;
    if (!container) return { x: nextX, y: nextY };

    const bounds = container.getBoundingClientRect();
    if (!bounds.width || !bounds.height) {
      return { x: nextX, y: nextY };
    }

    const imageElement = imageRef.current;
    const naturalWidth = imageElement?.naturalWidth || bounds.width;
    const naturalHeight = imageElement?.naturalHeight || bounds.height;
    const imageRatio = naturalWidth / naturalHeight;
    const containerRatio = bounds.width / bounds.height;

    const baseWidth = imageRatio > containerRatio ? bounds.width : bounds.height * imageRatio;
    const baseHeight = imageRatio > containerRatio ? bounds.width / imageRatio : bounds.height;

    const scaledWidth = baseWidth * nextScale;
    const scaledHeight = baseHeight * nextScale;
    const maxX = Math.max(0, (scaledWidth - bounds.width) / 2);
    const maxY = Math.max(0, (scaledHeight - bounds.height) / 2);

    return {
      x: clampValue(nextX, -maxX, maxX),
      y: clampValue(nextY, -maxY, maxY),
    };
  }, []);

  const updateTransform = useCallback((nextScale: number, nextX: number, nextY: number) => {
    const clampedScale = clampValue(nextScale, LIGHTBOX_MIN_SCALE, LIGHTBOX_MAX_SCALE);
    const clampedTranslate = clampTranslate(clampedScale, nextX, nextY);
    setScale(clampedScale);
    setTranslate(clampedTranslate);
  }, [clampTranslate]);

  const handleDoubleTap = useCallback((clientX: number, clientY: number) => {
    const container = containerRef.current;
    if (!container) return;

    if (scale > 1) {
      updateTransform(1, 0, 0);
      return;
    }

    const bounds = container.getBoundingClientRect();
    const relativeX = clientX - bounds.left - bounds.width / 2;
    const relativeY = clientY - bounds.top - bounds.height / 2;
    const nextScale = 2;
    const nextX = -relativeX * (nextScale - 1);
    const nextY = -relativeY * (nextScale - 1);
    updateTransform(nextScale, nextX, nextY);
  }, [scale, updateTransform]);

  useEffect(() => {
    if (!imageUrl) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [imageUrl]);

  useEffect(() => {
    if (!imageUrl) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onRequestClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [imageUrl, onRequestClose]);

  if (!imageUrl || typeof document === 'undefined') {
    return null;
  }

  const baseOpacity = isOpen ? 1 : 0;
  const overlayOpacity = Math.max(0, Math.min(1, baseOpacity - swipeOffsetY / 420));

  return createPortal(
    <div
      className={`fixed inset-0 z-[110] bg-black/90 transition-opacity duration-200 ${isOpen ? 'pointer-events-auto' : 'pointer-events-none'}`}
      style={{ opacity: overlayOpacity }}
      onClick={() => onRequestClose()}
      role="dialog"
      aria-modal="true"
      aria-label="Image lightbox"
    >
      <button
        type="button"
        className="absolute right-4 top-4 z-[120] rounded-full bg-black/50 p-2 text-white transition-colors hover:bg-black/70"
        onClick={(event) => {
          event.stopPropagation();
          onRequestClose();
        }}
        aria-label="Close image lightbox"
      >
        <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>

      <div
        ref={containerRef}
        className={`flex h-full w-full items-center justify-center px-3 py-8 transition-transform duration-200 ${isOpen ? 'scale-100' : 'scale-95'}`}
        onClick={(event) => event.stopPropagation()}
        onTouchStart={(event) => {
          event.stopPropagation();

          if (event.touches.length === 2) {
            setIsInteracting(true);
            const distance = touchDistance(event.touches);
            pinchRef.current = {
              startDistance: distance,
              startScale: scale,
              originX: translate.x,
              originY: translate.y,
            };
            panRef.current = null;
            swipeRef.current = null;
            return;
          }

          if (event.touches.length !== 1) {
            return;
          }

          const touch = event.touches[0];
          const now = Date.now();
          if (now - lastTapAtRef.current < LIGHTBOX_DOUBLE_TAP_MS) {
            event.preventDefault();
            lastTapAtRef.current = 0;
            handleDoubleTap(touch.clientX, touch.clientY);
            return;
          }

          lastTapAtRef.current = now;

          if (scale > 1) {
            setIsInteracting(true);
            panRef.current = {
              startX: touch.clientX,
              startY: touch.clientY,
              originX: translate.x,
              originY: translate.y,
            };
            swipeRef.current = null;
            return;
          }

          swipeRef.current = {
            startX: touch.clientX,
            startY: touch.clientY,
            deltaX: 0,
            deltaY: 0,
          };
          setIsInteracting(true);
        }}
        onTouchMove={(event) => {
          event.stopPropagation();

          if (event.touches.length === 2 && pinchRef.current) {
            event.preventDefault();
            const distance = touchDistance(event.touches);
            if (!pinchRef.current.startDistance) return;
            const pinchScale = pinchRef.current.startScale * (distance / pinchRef.current.startDistance);
            updateTransform(pinchScale, pinchRef.current.originX, pinchRef.current.originY);
            return;
          }

          if (event.touches.length !== 1) {
            return;
          }

          const touch = event.touches[0];

          if (scale > 1 && panRef.current) {
            event.preventDefault();
            const nextX = panRef.current.originX + (touch.clientX - panRef.current.startX);
            const nextY = panRef.current.originY + (touch.clientY - panRef.current.startY);
            updateTransform(scale, nextX, nextY);
            return;
          }

          if (swipeRef.current) {
            const deltaX = touch.clientX - swipeRef.current.startX;
            const deltaY = touch.clientY - swipeRef.current.startY;
            swipeRef.current.deltaX = deltaX;
            swipeRef.current.deltaY = deltaY;
            setSwipeOffsetY(Math.max(0, deltaY));
          }
        }}
        onTouchEnd={(event) => {
          event.stopPropagation();

          if (event.touches.length > 0) {
            return;
          }

          panRef.current = null;
          pinchRef.current = null;
          setIsInteracting(false);

          if (!swipeRef.current) {
            setSwipeOffsetY(0);
            return;
          }

          const shouldClose = swipeRef.current.deltaY > LIGHTBOX_SWIPE_CLOSE_THRESHOLD && Math.abs(swipeRef.current.deltaX) < 90;
          swipeRef.current = null;
          setSwipeOffsetY(0);
          if (shouldClose && scale <= 1) {
            onRequestClose();
          }
        }}
        onTouchCancel={() => {
          panRef.current = null;
          pinchRef.current = null;
          swipeRef.current = null;
          setSwipeOffsetY(0);
          setIsInteracting(false);
        }}
      >
        <img
          ref={imageRef}
          src={imageUrl}
          alt=""
          draggable={false}
          className="max-h-full w-full select-none object-contain will-change-transform"
          style={{
            transform: `translate3d(${translate.x}px, ${translate.y + swipeOffsetY}px, 0) scale(${scale})`,
            transition: isInteracting ? 'none' : 'transform 180ms ease',
            touchAction: scale > 1 ? 'none' : 'manipulation',
          }}
          onDoubleClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            handleDoubleTap(event.clientX, event.clientY);
          }}
          onDragStart={(event) => event.preventDefault()}
        />
      </div>
    </div>,
    document.body,
  );
}

function SourceInitialAvatar({ profile, compact = false }: { profile: SourceAvatarProfile; compact?: boolean }) {
  const sizeClassName = compact ? 'h-9 w-9 sm:h-10 sm:w-10' : 'h-11 w-11 sm:h-12 sm:w-12';

  return (
    <div className={`flex ${sizeClassName} items-center justify-center rounded-full text-sm font-semibold ${profile.avatarClassName}`}>
      {profile.initials}
    </div>
  );
}

function ThumbsUpIcon({ filled = false }: { filled?: boolean }) {
  return (
    <svg className="h-6 w-6" viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2">
      <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" />
    </svg>
  );
}

function ThumbsDownIcon({ filled = false }: { filled?: boolean }) {
  return (
    <svg className="h-6 w-6" viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2">
      <path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3H10zM17 2h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17" />
    </svg>
  );
}

function ReplyIcon() {
  return (
    <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  );
}

function RetweetIcon({ className = 'h-6 w-6' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M17 1l4 4-4 4" />
      <path d="M3 11V9a4 4 0 0 1 4-4h14" />
      <path d="M7 23l-4-4 4-4" />
      <path d="M21 13v2a4 4 0 0 1-4 4H3" />
    </svg>
  );
}

function PlayIcon({ className = 'h-6 w-6' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function HighlightedSearchText({ text, searchQuery }: { text: string; searchQuery?: string | null }) {
  const parts = useMemo(() => splitSearchHighlightParts(text, searchQuery), [searchQuery, text]);

  return (
    <>
      {parts.map((part, index) => part.isMatch ? (
        <span
          key={`${index}-${part.text}`}
          data-search-highlight="true"
          className="search-match rounded bg-amber-400/20 px-0.5 text-amber-100"
        >
          {part.text}
        </span>
      ) : (
        <span key={`${index}-${part.text}`}>{part.text}</span>
      ))}
    </>
  );
}

function highlightReactTextChildren(children: ReactNode, searchQuery?: string | null): ReactNode {
  if (!searchQuery) {
    return children;
  }

  return Children.map(children, (child) => {
    if (typeof child === 'string') {
      return <HighlightedSearchText text={child} searchQuery={searchQuery} />;
    }

    if (isValidElement<{ children?: ReactNode }>(child)) {
      const childChildren = child.props.children;
      if (!childChildren) {
        return child;
      }

      return cloneElement(child, undefined, highlightReactTextChildren(childChildren, searchQuery));
    }

    return child;
  });
}

function LinkifiedText({ text, searchQuery }: { text: string; searchQuery?: string | null }) {
  const parts = useMemo(() => linkifyText(text), [text]);

  return (
    <>
      {parts.map((part, index) => {
        if (part.type === 'text') {
          return (
            <span key={`${index}-${part.content}`}>
              <HighlightedSearchText text={part.content} searchQuery={searchQuery} />
            </span>
          );
        }

        return (
          <a
            key={`${index}-${part.content}`}
            href={part.href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sky-400 hover:text-sky-300 hover:underline"
            onClick={(event) => event.stopPropagation()}
          >
            <HighlightedSearchText text={part.content} searchQuery={searchQuery} />
          </a>
        );
      })}
    </>
  );
}

function DetailMetadata({
  timestamp,
  sourceLabel,
  url,
  urlLabel,
}: {
  timestamp: string;
  sourceLabel?: string | null;
  url?: string | null;
  urlLabel?: string;
}) {
  return (
    <div className="mt-5 border-t border-zinc-800/80 pt-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-zinc-500">
        <span>{timestamp}</span>
        {sourceLabel ? (
          <>
            <span aria-hidden="true">·</span>
            <span>{sourceLabel}</span>
          </>
        ) : null}
        {url ? (
          <>
            <span aria-hidden="true">·</span>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="truncate text-sky-400 transition-colors hover:text-sky-300 hover:underline"
              onClick={(event) => event.stopPropagation()}
            >
              {urlLabel || formatUrlForDisplay(url)}
            </a>
          </>
        ) : null}
      </div>
    </div>
  );
}

function MetricButton({
  icon,
  count,
  hoverColor,
  active,
  activeColor,
  onClick,
  disabled,
  ariaLabel,
  className,
}: {
  icon: React.ReactNode;
  count: number;
  hoverColor: string;
  active?: boolean;
  activeColor?: string;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  ariaLabel: string;
  className?: string;
}) {
  const hasCount = count > 0;

  return (
    <button
      type="button"
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onClick}
      className={`group inline-flex min-h-[44px] min-w-0 items-center justify-center whitespace-nowrap rounded-full text-[12px] leading-none transition-colors sm:text-[13px] ${hasCount ? 'gap-1 px-1 sm:gap-1.5 sm:px-2.5' : 'px-1.5 sm:px-2.5'} ${active ? activeColor : ''} ${hoverColor} ${disabled ? 'cursor-default opacity-80' : ''} ${className || ''}`}
    >
      <span className="shrink-0 [&>svg]:h-5 [&>svg]:w-5 sm:[&>svg]:h-6 sm:[&>svg]:w-6">{icon}</span>
      {hasCount && <span className="shrink-0 text-[11px] font-medium leading-none sm:text-[13px]">{formatNumber(count)}</span>}
    </button>
  );
}

function AgentActionButton({
  agentName,
  onClick,
  className,
}: {
  agentName: string;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label="Chat about this post"
      onClick={onClick}
      className={`group inline-flex min-h-[44px] min-w-0 items-center justify-center rounded-full px-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/70 focus-visible:ring-offset-0 ${className || ''}`}
    >
      <span className="inline-flex min-w-0 items-center rounded-md border-2 border-zinc-700 px-2 py-0.5 text-[11px] font-medium text-zinc-300 transition-colors group-hover:border-zinc-500 group-hover:bg-zinc-800 group-hover:text-zinc-100 group-focus-visible:border-zinc-500 group-focus-visible:bg-zinc-800 group-focus-visible:text-zinc-100">
        <span className="truncate">{agentName}</span>
      </span>
    </button>
  );
}

function ExportDocumentIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M12 11v6" />
      <path d="m9.5 14.5 2.5 2.5 2.5-2.5" />
    </svg>
  );
}

function ExportPdfButton({
  onClick,
}: {
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      aria-label="Export analysis as PDF"
      onClick={onClick}
      className="group inline-flex min-h-[44px] min-w-0 items-center justify-center rounded-full px-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/70 focus-visible:ring-offset-0"
    >
      <span className="inline-flex min-w-0 items-center gap-1.5 rounded-full border-2 border-zinc-700 px-3 py-1 text-[11px] font-medium text-zinc-300 transition-colors group-hover:border-zinc-500 group-hover:bg-zinc-800 group-hover:text-zinc-100 group-focus-visible:border-zinc-500 group-focus-visible:bg-zinc-800 group-focus-visible:text-zinc-100">
        <ExportDocumentIcon />
        <span className="truncate">Export PDF</span>
      </span>
    </button>
  );
}

function ReasonInput({
  onSubmit,
  onDismiss,
  signalType,
}: {
  onSubmit: (reason: string) => void;
  onDismiss: () => void;
  signalType: 'thumbsup' | 'thumbsdown';
}) {
  const [reason, setReason] = useState('');
  const stopPropagation = (event: React.SyntheticEvent) => {
    event.stopPropagation();
  };
  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onSubmit(reason);
  };

  return (
    <form
      className="mt-2 flex items-center gap-2"
      onSubmit={handleSubmit}
      onKeyDown={stopPropagation}
      onClick={stopPropagation}
      onTouchStart={stopPropagation}
    >
      <input
        type="text"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder={signalType === 'thumbsdown' ? 'Why not? (optional)' : 'Why? (optional)'}
        enterKeyHint="done"
        className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 placeholder-zinc-500 focus:border-zinc-500 focus:outline-none"
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Escape') {
            event.preventDefault();
            onDismiss();
          }
        }}
        onClick={stopPropagation}
        onTouchStart={stopPropagation}
        onFocus={stopPropagation}
        autoFocus
      />
      <button
        type="submit"
        onClick={(event) => {
          event.stopPropagation();
        }}
        onTouchStart={stopPropagation}
        className="text-sm text-sky-400 hover:text-sky-300"
      >
        Done
      </button>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onDismiss();
        }}
        onTouchStart={stopPropagation}
        className="text-sm text-zinc-500 hover:text-zinc-400"
      >
        Skip
      </button>
    </form>
  );
}

function MediaDisplay({
  media,
  tweetUrl,
  onImageClick,
  prominent = false,
}: {
  media: MediaItem[];
  tweetUrl?: string;
  onImageClick?: (url: string, event: React.MouseEvent<HTMLElement>) => void;
  prominent?: boolean;
}) {
  if (media.length === 0) return null;

  const displayedMedia = media.slice(0, 4);
  const imageCount = displayedMedia.length;
  const hasSingleVideo = imageCount === 1 && displayedMedia[0] && displayedMedia[0].type !== 'image';
  const gridClass = hasSingleVideo
    ? prominent
      ? 'grid-cols-1 aspect-video max-h-[640px]'
      : 'grid-cols-1 aspect-video max-h-[512px]'
    : imageCount === 1
      ? prominent
        ? 'grid-cols-1 max-h-[640px]'
        : 'grid-cols-1 max-h-[480px]'
    : imageCount === 2
      ? prominent
        ? 'grid-cols-2 h-[360px] max-h-[360px]'
        : 'grid-cols-2 h-[280px] max-h-[280px]'
      : prominent
        ? 'grid-cols-2 grid-rows-2 h-[420px] max-h-[420px]'
        : 'grid-cols-2 grid-rows-2 h-[300px] max-h-[300px]';

  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-zinc-800">
      <div className={`grid gap-0.5 overflow-hidden ${gridClass}`}>
        {displayedMedia.map((entry, index) => {
          const tileClass = imageCount === 3 && index === 0
            ? 'row-span-2 h-full'
            : 'h-full';
          const isVideo = entry.type === 'video' || entry.type === 'gif';
          const mediaSrc = getMediaThumbnailUrl(entry);
          const targetUrl = tweetUrl || entry.videoUrl || entry.url;
          const mediaAlt = entry.alt?.trim() ?? '';

          return (
            <div key={`${entry.url}-${index}`} className={`overflow-hidden bg-zinc-900 ${tileClass}`}>
              {isVideo ? (
                <a
                  href={targetUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="relative block h-full w-full"
                  onClick={(event) => event.stopPropagation()}
                  aria-label="Open post on X"
                >
                  <ResilientImage
                    src={mediaSrc}
                    alt={mediaAlt}
                    className="h-full w-full object-cover"
                  />
                  <div className="absolute inset-0 flex items-center justify-center bg-black/10 transition-colors hover:bg-black/20">
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-black/60 text-white">
                      <PlayIcon className="ml-1 h-5 w-5" />
                    </div>
                  </div>
                </a>
              ) : (
                <button
                  type="button"
                  className="block h-full w-full cursor-zoom-in"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (onImageClick) {
                      onImageClick(entry.url, event);
                      return;
                    }
                    window.open(entry.url, '_blank', 'noopener,noreferrer');
                  }}
                  aria-label="Open image in fullscreen lightbox"
                >
                  <ResilientImage
                    src={mediaSrc}
                    alt={mediaAlt}
                    className={`h-full w-full ${imageCount === 1 ? 'object-contain' : 'object-cover'}`}
                  />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function LinkPreviewCard({
  card,
}: {
  card: LinkCard | LinkPreview;
}) {
  const cardImageUrl = 'image' in card
    ? card.image || null
    : 'imageUrl' in card && typeof card.imageUrl === 'string'
      ? card.imageUrl
      : null;

  return (
    <a
      href={card.url}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-3 block overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950/60 transition-colors hover:bg-zinc-900/80"
      onClick={(event) => event.stopPropagation()}
    >
      {cardImageUrl && (
        <div className="relative block aspect-[1.91/1] w-full bg-zinc-900">
          <ResilientImage src={cardImageUrl} alt={card.imageAlt?.trim() || card.title} className="h-full w-full object-cover" />
        </div>
      )}
      <div className="p-3">
        <p className="line-clamp-2 text-[15px] font-semibold leading-snug text-zinc-100">{card.title || card.url}</p>
        {card.description && <p className="mt-1 line-clamp-2 text-sm text-zinc-400">{card.description}</p>}
        <p className="mt-2 truncate text-xs text-zinc-500">{card.domain || card.url}</p>
      </div>
    </a>
  );
}

export function CommunityNoteCallout({
  note,
}: {
  note: TweetCommunityNote;
}) {
  return (
    <div
      data-testid="tweet-community-note"
      className="mt-3 rounded-lg border border-sky-900/60 bg-sky-950/25 px-3 py-2 text-sm leading-relaxed text-zinc-300"
    >
      <p className="text-xs font-semibold text-sky-300">Readers added context</p>
      <p className="mt-1 whitespace-pre-wrap break-words">
        <LinkifiedText text={note.text} />
      </p>
      {note.sourceUrl && (
        <a
          href={note.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1 inline-flex text-xs font-medium text-sky-300 hover:text-sky-200"
          onClick={(event) => event.stopPropagation()}
        >
          Source
        </a>
      )}
    </div>
  );
}

function formatPollDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m left`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m left` : `${hours}h left`;
  const days = Math.floor(hours / 24);
  return days === 1 ? '1d left' : `${days}d left`;
}

function formatPollEndsAt(endsAt: string): string | null {
  const endMs = Date.parse(endsAt);
  if (!Number.isFinite(endMs)) return null;
  const remainingMinutes = Math.ceil((endMs - Date.now()) / 60000);
  if (remainingMinutes <= 0) return 'Final results';
  return formatPollDuration(remainingMinutes);
}

function TweetPoll({
  poll,
}: {
  poll: Poll;
}) {
  if (poll.options.length === 0) return null;

  const countedVotes = poll.options.reduce((sum, option) => sum + (option.voteCount ?? 0), 0);
  const totalVotes = typeof poll.totalVotes === 'number' ? poll.totalVotes : countedVotes;
  const footerParts = [
    totalVotes > 0 ? `${formatNumber(totalVotes)} ${totalVotes === 1 ? 'vote' : 'votes'}` : null,
    typeof poll.durationMinutes === 'number'
      ? formatPollDuration(poll.durationMinutes)
      : poll.endsAt
        ? formatPollEndsAt(poll.endsAt)
        : null,
  ].filter((part): part is string => Boolean(part));

  return (
    <div data-testid="tweet-poll" className="mt-3 space-y-2 rounded-xl border border-zinc-800 bg-zinc-950/50 p-3">
      {poll.options.map((option, index) => {
        const percentage = totalVotes > 0 && typeof option.voteCount === 'number'
          ? Math.min(100, Math.max(0, Math.round((option.voteCount / totalVotes) * 100)))
          : 0;

        return (
          <div key={`${option.label}-${index}`} className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/70">
            <div className="relative min-h-10">
              <div
                aria-hidden="true"
                className="absolute inset-y-0 left-0 bg-sky-500/20"
                style={{ width: `${percentage}%` }}
              />
              <div className="relative flex min-h-10 items-center justify-between gap-3 px-3 py-2 text-sm">
                <span className="break-words font-medium text-zinc-100">{option.label}</span>
                {typeof option.voteCount === 'number' && (
                  <span className="shrink-0 text-zinc-400">{formatNumber(option.voteCount)}</span>
                )}
              </div>
            </div>
          </div>
        );
      })}
      {footerParts.length > 0 && (
        <p className="text-xs text-zinc-500">{footerParts.join(' · ')}</p>
      )}
    </div>
  );
}

function ParentTweetPreview({
  item,
  onOpen,
  searchQuery,
}: {
  item: FeedItem;
  onOpen: () => void;
  searchQuery?: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const username = item.authorUsername || 'unknown';
  const displayName = item.authorDisplayName || username;
  const text = stripQuotedTweetUrlsForDisplay(item);
  const searchSnippet = searchQuery ? buildSearchSnippet(text, searchQuery, 180) : null;
  const usesSearchSnippet = searchSnippet?.hasMatch === true;
  const { needsTruncation, displayText } = usesSearchSnippet
    ? { needsTruncation: false, displayText: searchSnippet.text }
    : getTruncationState(text, expanded, CHILD_TEXT_TRUNCATION);
  const bodySearchQuery = usesSearchSnippet ? searchQuery : null;

  return (
    <div
      role="button"
      tabIndex={0}
      className="block w-full cursor-pointer rounded-lg text-left transition-colors hover:bg-zinc-900/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/70"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onOpen();
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        onOpen();
      }}
      aria-label="Open parent post"
    >
      <div className="relative z-10 flex gap-3">
        <div className="relative z-10 flex-shrink-0">
          {item.authorAvatarUrl ? (
            <ResilientImage src={item.authorAvatarUrl} alt={displayName} className="h-9 w-9 rounded-full object-cover sm:h-10 sm:w-10" />
          ) : (
            <Avatar name={displayName} sizeClassName="h-9 w-9 sm:h-10 sm:w-10" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5 overflow-hidden text-[14px]">
            <p className="shrink-0 truncate font-semibold text-zinc-200">{displayName}</p>
            <p className="truncate text-zinc-500">{username.startsWith('@') ? username : `@${username}`}</p>
            <span className="shrink-0 text-zinc-500">·</span>
            <p className="shrink-0 text-zinc-500">{formatFeedTimestamp(item)}</p>
          </div>
          {displayText && (
            <p className="mt-1 whitespace-pre-wrap break-words text-[15px] leading-relaxed text-zinc-300">
              <LinkifiedText text={displayText} searchQuery={bodySearchQuery} />
              {needsTruncation && !expanded && (
                <>
                  {'... '}
                  <button
                    type="button"
                    className="text-sky-400 hover:text-sky-300"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setExpanded(true);
                    }}
                  >
                    {EXPAND_LABEL}
                  </button>
                </>
              )}
              {needsTruncation && expanded && (
                <>
                  {' '}
                  <button
                    type="button"
                    className="text-sky-400 hover:text-sky-300"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setExpanded(false);
                    }}
                  >
                    {COLLAPSE_LABEL}
                  </button>
                </>
              )}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function ReplyTweetPreview({
  item,
  expanded,
  onToggleExpand,
  searchQuery,
}: {
  item: ChildPreview;
  expanded: boolean;
  onToggleExpand: () => void;
  searchQuery?: string | null;
}) {
  const username = item.authorUsername || 'unknown';
  const displayName = item.authorDisplayName || username;
  const timestamp = item.publishedAt ? formatRelativeTime(item.publishedAt) : null;
  const replyText = stripLeadingReplyMentions(item.text);
  const searchSnippet = searchQuery ? buildSearchSnippet(replyText, searchQuery, 180) : null;
  const usesSearchSnippet = searchSnippet?.hasMatch === true;
  const { needsTruncation, displayText } = usesSearchSnippet
    ? { needsTruncation: false, displayText: searchSnippet.text }
    : getTruncationState(replyText, expanded, CHILD_TEXT_TRUNCATION);
  const bodySearchQuery = usesSearchSnippet ? searchQuery : null;

  return (
    <div className="flex gap-3 py-1.5 text-sm text-zinc-400">
      <div className="flex-shrink-0">
        {item.authorAvatarUrl ? (
          <ResilientImage src={item.authorAvatarUrl} alt={displayName} className="h-9 w-9 rounded-full object-cover sm:h-10 sm:w-10" />
        ) : (
          <Avatar name={displayName} sizeClassName="h-9 w-9 sm:h-10 sm:w-10" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5 overflow-hidden text-[14px]">
          <p className="shrink-0 truncate font-semibold text-zinc-200">{displayName}</p>
          <p className="truncate text-zinc-500">{username.startsWith('@') ? username : `@${username}`}</p>
          {timestamp && (
            <>
              <span className="shrink-0 text-zinc-500">·</span>
              <p className="shrink-0 text-zinc-500">{timestamp}</p>
            </>
          )}
        </div>

        {displayText && (
          <p className="mt-1 whitespace-pre-wrap break-words text-[15px] leading-relaxed text-zinc-300">
            <LinkifiedText text={displayText} searchQuery={bodySearchQuery} />
            {needsTruncation && !expanded && (
              <>
                {'... '}
                <button
                  type="button"
                  className="text-sky-400 hover:text-sky-300"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onToggleExpand();
                  }}
                >
                  {EXPAND_LABEL}
                </button>
              </>
            )}
            {needsTruncation && expanded && (
              <>
                {' '}
                <button
                  type="button"
                  className="text-sky-400 hover:text-sky-300"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onToggleExpand();
                  }}
                >
                  {COLLAPSE_LABEL}
                </button>
              </>
            )}
          </p>
        )}
      </div>
    </div>
  );
}

function ChildAnalysisPreview({
  item,
  agentName,
  expanded,
  onToggleExpand,
  searchQuery,
}: {
  item: ChildPreview;
  agentName: string;
  expanded: boolean;
  onToggleExpand: () => void;
  searchQuery?: string | null;
}) {
  const analysisAuthorDisplayName = item.authorDisplayName?.trim() || agentName.trim() || 'Evogent';
  const sourceProfile = resolveAgentSourceProfile(analysisAuthorDisplayName);
  const timestamp = item.publishedAt ? formatRelativeTime(item.publishedAt) : null;
  const title = item.title?.trim() || null;
  const searchSnippet = searchQuery ? buildSearchSnippet(item.text, searchQuery, 180, { prefer: 'last' }) : null;
  const usesSearchSnippet = searchSnippet?.hasMatch === true;
  const { needsTruncation, displayText } = usesSearchSnippet
    ? { needsTruncation: false, displayText: searchSnippet.text }
    : getTruncationState(item.text, expanded, CHILD_TEXT_TRUNCATION);

  return (
    <div className="flex gap-3 py-1.5 text-sm text-zinc-400">
      <div className="flex-shrink-0">
        <SourceInitialAvatar profile={sourceProfile} compact />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5 overflow-hidden text-[14px]">
          <p className="truncate font-semibold text-zinc-100">{sourceProfile.displayName}</p>
          {timestamp && (
            <>
              <span className="shrink-0 text-zinc-500">·</span>
              <p className="shrink-0 text-zinc-500">{timestamp}</p>
            </>
          )}
        </div>

        {title ? (
          <h3 className="font-semibold text-zinc-100 text-[15px] leading-snug">{title}</h3>
        ) : null}

        {displayText ? (
          <div className="relative mt-1 select-text touch-auto">
            <article className={CHILD_ANALYSIS_BODY_CLASS_NAME}>
              {usesSearchSnippet ? (
                <p>
                  <HighlightedSearchText text={displayText} searchQuery={searchQuery} />
                </p>
              ) : (
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    a: ({ href, children, ...props }) => (
                      <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sky-400 hover:text-sky-300 hover:underline"
                        onClick={(event) => event.stopPropagation()}
                        {...props}
                      >
                        {children}
                      </a>
                    ),
                  }}
                >
                  {displayText}
                </ReactMarkdown>
              )}
            </article>
            {needsTruncation && (
              <button
                type="button"
                aria-expanded={expanded}
                className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-sky-700/40 bg-sky-500/10 px-3 py-1 text-sm font-medium text-sky-300 transition-colors hover:border-sky-500/60 hover:bg-sky-500/20 hover:text-sky-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/70"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onToggleExpand();
                }}
              >
                <span>{expanded ? CHILD_ANALYSIS_COLLAPSE_LABEL : CHILD_ANALYSIS_EXPAND_LABEL}</span>
                <svg
                  aria-hidden="true"
                  className={`h-3.5 w-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function QuoteTweetCard({
  quote,
  showMetrics = false,
  onImageClick,
  onQuoteTweetClick,
  searchQuery,
}: {
  quote: QuoteTweet;
  showMetrics?: boolean;
  onImageClick?: (url: string, event: React.MouseEvent<HTMLElement>) => void;
  onQuoteTweetClick?: (quote: QuoteTweet) => void | Promise<void>;
  searchQuery?: string | null;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const quoteText = quote.media && quote.media.length > 0 ? stripTrailingTweetMediaUrls(quote.text) : quote.text;
  const searchSnippet = searchQuery ? buildSearchSnippet(quoteText, searchQuery, 180) : null;
  const usesSearchSnippet = searchSnippet?.hasMatch === true;
  const textLen = quoteText?.length ?? 0;
  const lineCount = quoteText ? quoteText.split('\n').length : 0;
  const needsTruncation = textLen > 200 || lineCount > 4;
  const displayText = (() => {
    if (usesSearchSnippet) return searchSnippet.text;
    if (!needsTruncation || isExpanded) return quoteText;
    const text = quoteText;
    const charCut = text.slice(0, 200);
    const lineCut = text.split('\n').slice(0, 4).join('\n');
    return charCut.length < lineCut.length ? charCut : lineCut;
  })();
  const resolvedNeedsTruncation = usesSearchSnippet ? false : needsTruncation;
  const bodySearchQuery = usesSearchSnippet ? searchQuery : null;
  const quoteMetrics = quote.metrics ?? null;
  const hasQuoteMetrics = quoteMetrics !== null
    && (quoteMetrics.likes > 0 || quoteMetrics.reposts > 0 || quoteMetrics.replies > 0);
  const quoteAuthor = quote.author && typeof quote.author === 'object'
    ? quote.author
    : { username: '' };
  const authorUsername = quoteAuthor.username || 'unknown';
  const authorDisplayName = quoteAuthor.displayName || quoteAuthor.name || authorUsername || 'Unknown author';
  const handleOpenQuote = () => {
    if (onQuoteTweetClick) {
      onQuoteTweetClick(quote);
      return;
    }

    if (quote.url) {
      window.open(quote.url, '_blank', 'noopener,noreferrer');
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      data-testid="quoted-tweet-preview"
      className="mt-3 cursor-pointer rounded-2xl border border-zinc-700 p-3 transition-colors hover:bg-zinc-900/40"
      onClick={(event) => {
        event.stopPropagation();
        handleOpenQuote();
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        handleOpenQuote();
      }}
      aria-label="Open quoted post"
    >
      <div className="flex items-center gap-2">
        {quoteAuthor.avatarUrl ? (
          <ResilientImage src={quoteAuthor.avatarUrl} alt="" className="h-6 w-6 rounded-full object-cover" />
        ) : (
          <div className="flex h-6 w-6 items-center justify-center rounded-full bg-zinc-700 text-xs font-semibold text-zinc-100">
            {(authorDisplayName[0] || '?').toUpperCase()}
          </div>
        )}
        <p className="truncate text-sm font-semibold text-zinc-100">{authorDisplayName}</p>
        <p className="truncate text-sm text-zinc-500">@{authorUsername}</p>
        {quote.publishedAt && (
          <span className="shrink-0 text-sm text-zinc-500">· {formatRelativeTime(quote.publishedAt)}</span>
        )}
      </div>

      {displayText && (
        <p className="mt-2 whitespace-pre-wrap break-words text-[15px] text-zinc-200">
          <LinkifiedText text={displayText} searchQuery={bodySearchQuery} />
          {resolvedNeedsTruncation && !isExpanded && (
            <>
              {'... '}
              <button
                type="button"
                className="text-sky-400 hover:text-sky-300"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setIsExpanded(true);
                }}
              >
                {EXPAND_LABEL}
              </button>
            </>
          )}
          {resolvedNeedsTruncation && isExpanded && (
            <>
              {' '}
              <button
                type="button"
                className="text-sky-400 hover:text-sky-300"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setIsExpanded(false);
                }}
              >
                {COLLAPSE_LABEL}
              </button>
            </>
          )}
        </p>
      )}

      {quote.communityNote && <CommunityNoteCallout note={quote.communityNote} />}
      {quote.poll && <TweetPoll poll={quote.poll} />}

      {quote.media && quote.media.length > 0 && (
        <MediaDisplay media={quote.media} tweetUrl={quote.url} onImageClick={onImageClick} />
      )}
      {quote.linkCard && <LinkPreviewCard card={quote.linkCard} />}

      {showMetrics && hasQuoteMetrics && quoteMetrics && (
        <div className="mt-3 border-t border-zinc-800/80 pt-2 text-zinc-400">
          <div
            data-testid="quoted-tweet-metrics"
            className="grid w-full min-w-0 gap-1"
            style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}
          >
            <MetricButton
              icon={<ReplyIcon />}
              count={quoteMetrics.replies}
              hoverColor="group-hover:text-sky-400 group-hover:bg-sky-500/10"
              disabled
              ariaLabel="Replies"
              className="w-full px-1.5"
            />
            <MetricButton
              icon={<RetweetIcon />}
              count={quoteMetrics.reposts}
              hoverColor="group-hover:text-emerald-400 group-hover:bg-emerald-500/10"
              disabled
              ariaLabel="Reposts"
              className="w-full px-1.5"
            />
            <MetricButton
              icon={<ThumbsUpIcon filled={false} />}
              count={quoteMetrics.likes}
              hoverColor="group-hover:text-rose-400 group-hover:bg-rose-500/10"
              disabled
              ariaLabel="Likes"
              className="w-full px-1.5"
            />
          </div>
        </div>
      )}
    </div>
  );
}

function asTweetMedia(item: FeedItem): MediaItem[] {
  const media = getFeedMediaItems(item);
  if (media.length > 0) {
    return media;
  }

  const ogImage = readMetadataString(item.metadata, 'ogImage');
  if (!ogImage) {
    return [];
  }

  return [{
    type: 'image',
    url: ogImage,
  }];
}

export function TweetCard({
  item,
  agentName,
  showQuoteMetrics,
  childPreviews,
  fullWidth = false,
  hideFeedbackActions = false,
  isLiked,
  isDisliked,
  votePending,
  metricsLikes,
  onThumbsUp,
  onThumbsDown,
  expanded,
  onToggleExpand,
  showReasonInput,
  onReasonSubmit,
  onDismissReasonInput,
  onImageClick,
  onQuoteTweetClick,
  replyingToHandle = null,
  onChat,
  searchQuery,
  useSearchSnippet = true,
}: {
  item: FeedItem;
  agentName: string;
  showQuoteMetrics: boolean;
  childPreviews?: React.ReactNode;
  fullWidth?: boolean;
  hideFeedbackActions?: boolean;
  isLiked: boolean;
  isDisliked: boolean;
  votePending: boolean;
  metricsLikes: number;
  onThumbsUp: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onThumbsDown: (event: React.MouseEvent<HTMLButtonElement>) => void;
  expanded: boolean;
  onToggleExpand: () => void;
  showReasonInput: 'thumbsup' | 'thumbsdown' | null;
  onReasonSubmit: (reason: string) => void;
  onDismissReasonInput: () => void;
  onImageClick: (url: string, event: React.MouseEvent<HTMLElement>) => void;
  onQuoteTweetClick: (quote: QuoteTweet) => void | Promise<void>;
  replyingToHandle?: string | null;
  onChat?: (item: FeedItem, selectedText?: string) => void;
  searchQuery?: string | null;
  useSearchSnippet?: boolean;
}) {
  const username = item.authorUsername || 'unknown';
  const displayName = item.authorDisplayName || username;
  const linkPreviews = getTweetLinkPreviews(item);
  const rawTweetText = stripLinkPreviewUrlsForDisplay(item, stripQuotedTweetUrlsForDisplay(item));
  const displayTweetText = item.relationship === 'reply' ? stripLeadingReplyMentions(rawTweetText) : rawTweetText;
  const searchSnippet = searchQuery && useSearchSnippet ? buildSearchSnippet(displayTweetText, searchQuery, 220) : null;
  const usesSearchSnippet = searchSnippet?.hasMatch === true;
  const { needsTruncation, displayText } = usesSearchSnippet
    ? { needsTruncation: false, displayText: searchSnippet.text }
    : getTruncationState(displayTweetText, expanded, MAIN_TEXT_TRUNCATION);
  const bodySearchQuery = usesSearchSnippet || !useSearchSnippet ? searchQuery : null;
  const media = asTweetMedia(item);
  const subtitle = resolveOgDescriptionSubtitle(item.metadata, displayTweetText);
  const isProminent = isProminentFeedItem(item);
  const primaryLinkLabel = resolveSourceOpenLabel(item.source);
  const secondaryLink = resolveSecondarySourceLink(item);
  const detailSourceLabel = resolveSourceDisplayLabel(item.source);
  const hasChildPreviews = Boolean(childPreviews);
  const hackerNewsPoints = resolveHackerNewsPoints(item);
  const thumbsUpCount = isHackerNewsFeedItem(item) ? 0 : metricsLikes;
  const actionBarClassName = fullWidth
    ? 'mt-4 border-y border-zinc-800/80 py-2 text-zinc-400'
    : 'mt-2 border-t border-zinc-800/80 pt-2 text-zinc-400';
  const metricsRow = (
    <div
      data-testid={fullWidth ? 'tweet-action-bar-primary-full-width' : 'tweet-action-bar-primary'}
      className={`-ml-1 flex w-full min-w-0 flex-nowrap items-center gap-1 ${fullWidth ? 'sm:ml-[-4px]' : 'sm:ml-0'} ${hasChildPreviews ? 'sm:gap-1.5' : 'sm:w-auto sm:flex-1 sm:gap-1.5'}`}
    >
      {hideFeedbackActions ? (
        <>
          <MetricButton
            icon={<ThumbsUpIcon filled={false} />}
            count={thumbsUpCount}
            hoverColor="group-hover:text-zinc-400 group-hover:bg-zinc-800/60"
            disabled
            ariaLabel="Likes"
            className="shrink-0"
          />
          <HackerNewsPointsIndicator points={hackerNewsPoints} />
        </>
      ) : (
        <>
          <MetricButton
            icon={<ThumbsUpIcon filled={isLiked} />}
            count={thumbsUpCount}
            hoverColor="group-hover:text-emerald-400 group-hover:bg-emerald-500/10"
            active={isLiked}
            activeColor="text-emerald-400"
            onClick={onThumbsUp}
            disabled={votePending}
            ariaLabel={isLiked ? 'Remove thumbs up' : 'Thumbs up'}
            className="shrink-0"
          />
          <HackerNewsPointsIndicator points={hackerNewsPoints} />
          <MetricButton
            icon={<ThumbsDownIcon filled={isDisliked} />}
            count={0}
            hoverColor="group-hover:text-red-400 group-hover:bg-red-500/10"
            active={isDisliked}
            activeColor="text-red-400"
            onClick={onThumbsDown}
            disabled={votePending}
            ariaLabel={isDisliked ? 'Remove thumbs down' : 'Thumbs down'}
            className="shrink-0"
          />
          {onChat && (
            <AgentActionButton
              agentName={agentName}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onChat(item);
              }}
              className="shrink-0"
            />
          )}
        </>
      )}
      <MetricButton
        icon={<ReplyIcon />}
        count={item.metrics.replies}
        hoverColor="group-hover:text-sky-400 group-hover:bg-sky-500/10"
        disabled
        ariaLabel="Replies"
        className="shrink-0"
      />
      <MetricButton
        icon={<RetweetIcon />}
        count={item.metrics.reposts}
        hoverColor="group-hover:text-emerald-400 group-hover:bg-emerald-500/10"
        disabled
        ariaLabel="Reposts"
        className="shrink-0"
      />
    </div>
  );
  const openLinkRow = (item.url || secondaryLink) ? (
    <div className={hasChildPreviews ? 'flex w-full justify-end' : 'flex w-full justify-end sm:w-auto sm:flex-none'}>
      <div className="flex flex-wrap items-center justify-end gap-1 sm:gap-1.5">
        {secondaryLink && (
          <a
            href={secondaryLink.href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-[44px] items-center rounded-full px-2.5 text-[12px] font-medium text-zinc-400 transition-colors hover:bg-zinc-800/80 hover:text-zinc-200 sm:text-xs"
            onClick={(event) => event.stopPropagation()}
          >
            {secondaryLink.label}
          </a>
        )}
        {item.url && (
          <a
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-[44px] items-center rounded-full px-2.5 text-[12px] font-medium text-sky-400 transition-colors hover:bg-sky-500/10 hover:text-sky-300 sm:text-xs"
            onClick={(event) => event.stopPropagation()}
          >
            {primaryLinkLabel}
          </a>
        )}
      </div>
    </div>
  ) : null;

  const retweetedBy = item.metadata?.retweetedBy?.displayName || item.metadata?.retweetedBy?.username;
  const actionBar = (
    <div className={actionBarClassName}>
      {hasChildPreviews ? (
        <>
          {metricsRow}
          {childPreviews}
          {openLinkRow}
        </>
      ) : (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-2 sm:flex-nowrap sm:justify-between">
          {metricsRow}
          {openLinkRow}
        </div>
      )}
    </div>
  );
  if (fullWidth) {
    return (
      <>
        {item.metadata?.isRetweet && (
          <div className="mb-2 ml-[60px] flex items-center gap-1 text-xs text-zinc-500">
            <RetweetIcon className="h-3 w-3" />
            <span>{retweetedBy ? `${retweetedBy} reposted` : 'Reposted'}</span>
          </div>
        )}

        <div className="space-y-4">
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0">
              {item.authorAvatarUrl ? (
                <ResilientImage src={item.authorAvatarUrl} alt={displayName} className="h-12 w-12 rounded-full object-cover" loading="eager" />
              ) : (
                <Avatar name={displayName} />
              )}
            </div>

            <div className="min-w-0">
              {item.authorUsername ? (
                <a
                  href={`https://x.com/${item.authorUsername}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(event) => event.stopPropagation()}
                  className="block truncate text-lg font-semibold text-zinc-100 hover:underline"
                >
                  {displayName}
                </a>
              ) : (
                <p className="truncate text-lg font-semibold text-zinc-100">{displayName}</p>
              )}
              <p className="truncate text-sm text-zinc-500">{username.startsWith('@') ? username : `@${username}`}</p>
            </div>
          </div>

          {displayText && (
            <div className="relative select-text touch-auto">
              {replyingToHandle && (
                <p className="mb-2 text-sm text-zinc-500">
                  Replying to <span className="text-zinc-400">{replyingToHandle}</span>
                </p>
              )}
              <p className={`whitespace-pre-wrap break-words text-zinc-100 ${isProminent ? 'text-[24px] leading-[1.22] sm:text-[28px]' : 'text-[20px] leading-[1.45] sm:text-[22px]'}`}>
                <LinkifiedText text={displayText} searchQuery={bodySearchQuery} />
                {needsTruncation && !expanded && (
                  <>
                    {'... '}
                    <button
                      type="button"
                      className="text-sky-400 hover:text-sky-300"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onToggleExpand();
                      }}
                    >
                      {EXPAND_LABEL}
                    </button>
                  </>
                )}
                {needsTruncation && expanded && (
                  <>
                    {' '}
                    <button
                      type="button"
                      className="text-sky-400 hover:text-sky-300"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onToggleExpand();
                      }}
                    >
                      {COLLAPSE_LABEL}
                    </button>
                  </>
                )}
              </p>
            </div>
          )}

          {subtitle && (
            <p className="text-[15px] leading-7 text-zinc-500 sm:text-base">
              {subtitle}
            </p>
          )}

          {item.metadata?.communityNote && <CommunityNoteCallout note={item.metadata.communityNote} />}
          {item.metadata?.poll && <TweetPoll poll={item.metadata.poll} />}
          {media.length > 0 && <MediaDisplay media={media} tweetUrl={item.url || undefined} onImageClick={onImageClick} prominent />}
          {linkPreviews.map((preview) => <LinkPreviewCard key={preview.url} card={preview} />)}
          {item.metadata?.quotedTweet && (
            <QuoteTweetCard
              quote={item.metadata.quotedTweet}
              showMetrics={showQuoteMetrics}
              onImageClick={onImageClick}
              onQuoteTweetClick={onQuoteTweetClick}
              searchQuery={searchQuery}
            />
          )}

          <DetailMetadata
            timestamp={formatAbsoluteTimestamp(item.publishedAt)}
            sourceLabel={detailSourceLabel}
          />

          {actionBar}

          {showReasonInput && (
            <ReasonInput
              signalType={showReasonInput}
              onSubmit={onReasonSubmit}
              onDismiss={onDismissReasonInput}
            />
          )}
        </div>
      </>
    );
  }

  return (
    <>
      {item.metadata?.isRetweet && (
        <div className="mb-1 ml-11 flex items-center gap-1 text-xs text-zinc-500">
          <RetweetIcon className="h-3 w-3" />
          <span>{retweetedBy ? `${retweetedBy} reposted` : 'Reposted'}</span>
        </div>
      )}

      <div>
        <div className="flex items-start gap-3">
          <div className="flex-shrink-0">
            {item.authorAvatarUrl ? (
              <ResilientImage src={item.authorAvatarUrl} alt={displayName} className="h-11 w-11 rounded-full object-cover sm:h-12 sm:w-12" />
            ) : (
              <Avatar name={displayName} />
            )}
          </div>

          <div className="min-w-0 flex-1">
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-1.5 overflow-hidden text-[15px]">
                {item.authorUsername ? (
                  <a
                    href={`https://x.com/${item.authorUsername}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(event) => event.stopPropagation()}
                    className="block truncate font-semibold text-zinc-100 hover:underline"
                  >
                    {displayName}
                  </a>
                ) : (
                  <p className="truncate font-semibold text-zinc-100">{displayName}</p>
                )}
                <span className="shrink-0 text-zinc-500">·</span>
                <p className="shrink-0 text-zinc-500">{formatFeedTimestamp(item)}</p>
              </div>
              <p className="truncate text-[14px] text-zinc-500">{username.startsWith('@') ? username : `@${username}`}</p>
            </div>
          </div>
        </div>

        {replyingToHandle && (
          <p className="mt-2 text-[13px] text-zinc-500">
            Replying to <span className="text-zinc-400">{replyingToHandle}</span>
          </p>
        )}

        {displayText && (
          <div className={`relative select-text touch-auto ${isProminent ? 'mt-4' : 'mt-3'}`}>
            <p className={`whitespace-pre-wrap break-words text-zinc-200 ${isProminent ? 'text-[19px] leading-[1.28] sm:text-[20px]' : 'text-[17px] leading-snug'}`}>
              <LinkifiedText text={displayText} searchQuery={bodySearchQuery} />
              {needsTruncation && !expanded && (
                <>
                  {'... '}
                  <button
                    type="button"
                    className="text-sky-400 hover:text-sky-300"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      onToggleExpand();
                    }}
                  >
                    {EXPAND_LABEL}
                  </button>
                </>
              )}
              {needsTruncation && expanded && (
                <>
                  {' '}
                  <button
                    type="button"
                    className="text-sky-400 hover:text-sky-300"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      onToggleExpand();
                    }}
                  >
                    {COLLAPSE_LABEL}
                  </button>
                </>
              )}
            </p>
          </div>
        )}

        {subtitle && (
          <p className="mt-1 text-[14px] leading-relaxed text-zinc-500">
            {subtitle}
          </p>
        )}

        {item.metadata?.communityNote && <CommunityNoteCallout note={item.metadata.communityNote} />}
        {item.metadata?.poll && <TweetPoll poll={item.metadata.poll} />}
        {media.length > 0 && <MediaDisplay media={media} tweetUrl={item.url || undefined} onImageClick={onImageClick} />}
        {linkPreviews.map((preview) => <LinkPreviewCard key={preview.url} card={preview} />)}
        {item.metadata?.quotedTweet && (
          <QuoteTweetCard
            quote={item.metadata.quotedTweet}
            showMetrics={showQuoteMetrics}
              onImageClick={onImageClick}
              onQuoteTweetClick={onQuoteTweetClick}
              searchQuery={searchQuery}
            />
        )}

        {actionBar}

        {showReasonInput && (
          <ReasonInput
            signalType={showReasonInput}
            onSubmit={onReasonSubmit}
            onDismiss={onDismissReasonInput}
          />
        )}
      </div>

    </>
  );
}

export function ArticleCard({
  item,
  agentName,
  childPreviews,
  fullWidth = false,
  detail = fullWidth,
  isLiked,
  isDisliked,
  votePending,
  onThumbsUp,
  onThumbsDown,
  expanded,
  onToggleExpand,
  showReasonInput,
  onReasonSubmit,
  onDismissReasonInput,
  onChat,
  searchQuery,
  useSearchSnippet = true,
}: {
  item: FeedItem;
  agentName: string;
  childPreviews?: React.ReactNode;
  fullWidth?: boolean;
  detail?: boolean;
  isLiked: boolean;
  isDisliked: boolean;
  votePending: boolean;
  onThumbsUp: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onThumbsDown: (event: React.MouseEvent<HTMLButtonElement>) => void;
  expanded: boolean;
  onToggleExpand: () => void;
  showReasonInput: 'thumbsup' | 'thumbsdown' | null;
  onReasonSubmit: (reason: string) => void;
  onDismissReasonInput: () => void;
  onChat?: (item: FeedItem, selectedText?: string) => void;
  searchQuery?: string | null;
  useSearchSnippet?: boolean;
}) {
  const sourceProfile = resolveSourceAvatarProfile(item.source, agentName);
  const articleHeaderDisplayName = resolveArticleHeaderDisplayName(item, sourceProfile);
  const articleAvatarUrl = resolveArticleAvatarUrl(item);
  const media = getFeedMediaItems(item);
  const youtubeVideo = isYouTubeSource(item.source)
    ? getYouTubeFeedData({
        source: item.source,
        sourceId: item.sourceId,
        url: item.url,
        title: item.title,
        text: item.text,
        authorUsername: item.authorUsername,
        authorDisplayName: item.authorDisplayName,
        metadata: item.metadata,
        mediaUrls: item.mediaUrls,
      })
    : null;
  const body = youtubeVideo
    ? (youtubeVideo.description
      ?? item.excerpt
      ?? stripRepeatedLead(item.text, youtubeVideo.title))
    : (item.excerpt || stripRepeatedLead(item.text, item.title));
  const searchSnippet = searchQuery && useSearchSnippet ? buildSearchSnippet(body, searchQuery, 220) : null;
  const usesSearchSnippet = searchSnippet?.hasMatch === true;
  const { needsTruncation, displayText } = usesSearchSnippet
    ? { needsTruncation: false, displayText: searchSnippet.text }
    : getTruncationState(body, expanded, MAIN_TEXT_TRUNCATION);
  const bodySearchQuery = usesSearchSnippet || !useSearchSnippet ? searchQuery : null;
  const isProminent = isProminentFeedItem(item);
  const linkUrl = youtubeVideo?.canonicalUrl ?? item.url;
  const linkLabel = youtubeVideo?.liveStatus === 'live'
    ? 'Watch live'
    : youtubeVideo?.liveStatus === 'upcoming'
      ? 'View on YouTube'
      : youtubeVideo
        ? 'Watch video'
        : 'Read original';
  const secondaryLink = resolveSecondarySourceLink(item);
  const hasChildPreviews = Boolean(childPreviews);
  const hackerNewsPoints = resolveHackerNewsPoints(item);
  const actionBarClassName = fullWidth
    ? 'mt-5 border-y border-zinc-800/80 py-2 text-zinc-400'
    : 'mt-2 border-t border-zinc-800/80 pt-2 text-zinc-400';
  const metricsRow = (
    <div className="flex items-center gap-1">
      <MetricButton
        icon={<ThumbsUpIcon filled={isLiked} />}
        count={0}
        hoverColor="group-hover:text-emerald-400 group-hover:bg-emerald-500/10"
        active={isLiked}
        activeColor="text-emerald-400"
        onClick={onThumbsUp}
        disabled={votePending}
        ariaLabel={isLiked ? 'Remove thumbs up' : 'Thumbs up'}
      />
      <HackerNewsPointsIndicator points={hackerNewsPoints} />
      <MetricButton
        icon={<ThumbsDownIcon filled={isDisliked} />}
        count={0}
        hoverColor="group-hover:text-red-400 group-hover:bg-red-500/10"
        active={isDisliked}
        activeColor="text-red-400"
        onClick={onThumbsDown}
        disabled={votePending}
        ariaLabel={isDisliked ? 'Remove thumbs down' : 'Thumbs down'}
      />
      {onChat && (
        <AgentActionButton
          agentName={agentName}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onChat(item);
          }}
        />
      )}
    </div>
  );
  const openLinkRow = (linkUrl || secondaryLink) ? (
    <div className="flex justify-end">
      <div className="flex flex-wrap items-center justify-end gap-1 sm:gap-1.5">
        {secondaryLink && (
          <a
            href={secondaryLink.href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-[44px] items-center rounded-full px-2.5 text-[12px] font-medium text-zinc-400 transition-colors hover:bg-zinc-800/80 hover:text-zinc-200 sm:text-xs"
            onClick={(event) => event.stopPropagation()}
          >
            {secondaryLink.label}
          </a>
        )}
        {linkUrl && (
          <a
            href={linkUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-[44px] items-center rounded-full px-2.5 text-[12px] font-medium text-sky-400 transition-colors hover:bg-sky-500/10 hover:text-sky-300 sm:text-xs"
            onClick={(event) => event.stopPropagation()}
          >
            {linkLabel}
          </a>
        )}
      </div>
    </div>
  ) : null;
  const actionBar = (
    <div className={actionBarClassName}>
      <div className={`flex items-center justify-between ${fullWidth ? 'flex-wrap gap-3' : ''}`}>
        {metricsRow}
        {openLinkRow}
      </div>
      {hasChildPreviews && childPreviews}
    </div>
  );
  if (youtubeVideo) {
    const channelLabel = youtubeVideo.channelName || youtubeVideo.channelHandle || 'YouTube';
    const scheduledLabel = formatYouTubeScheduledLabel(youtubeVideo);
    const viewLabel = resolveYouTubeViewLabel(youtubeVideo);
    const statusBadgeLabel = youtubeVideo.liveStatus === 'live'
      ? 'Live'
      : youtubeVideo.liveStatus === 'upcoming'
        ? 'Upcoming'
        : 'YouTube';
    const statusSummaryLabel = youtubeVideo.liveStatus === 'live'
      ? 'Live now'
      : youtubeVideo.liveStatus === 'upcoming'
        ? (scheduledLabel ? `Upcoming • ${scheduledLabel}` : 'Upcoming')
        : null;
    const statusBadgeClass = youtubeVideo.liveStatus === 'live'
      ? 'bg-red-600 text-white'
      : youtubeVideo.liveStatus === 'upcoming'
        ? 'bg-amber-400 text-zinc-950'
        : 'bg-black/75 text-white';
    const statusSummaryClass = youtubeVideo.liveStatus === 'live'
      ? 'border-red-500/50 bg-red-500/12 text-red-200'
      : 'border-amber-400/40 bg-amber-400/12 text-amber-100';

    return (
      <div className="space-y-3">
        <div className="relative overflow-hidden rounded-[20px] border border-zinc-800/80 bg-black">
          <ResilientImage
            src={youtubeVideo.thumbnailUrl}
            alt={youtubeVideo.title || item.title || 'YouTube video'}
            className="aspect-video w-full object-cover"
            fallbackClassName="aspect-video bg-zinc-900"
          />
          <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-3">
            <span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] shadow-sm ${statusBadgeClass}`}>
              {statusBadgeLabel}
            </span>
            {!youtubeVideo.liveStatus && youtubeVideo.duration && (
              <span className="rounded-md bg-black/80 px-2 py-1 text-[11px] font-medium text-white shadow-sm">
                {youtubeVideo.duration}
              </span>
            )}
          </div>
          {statusSummaryLabel && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/35 to-transparent p-3">
              <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold ${statusSummaryClass}`}>
                {statusSummaryLabel}
              </span>
            </div>
          )}
        </div>

        <div className="flex items-start gap-3">
          <div className="flex-shrink-0">
            {articleAvatarUrl ? (
              <ResilientImage
                src={articleAvatarUrl}
                alt={channelLabel}
                className="h-11 w-11 rounded-full object-cover sm:h-12 sm:w-12"
                fallbackClassName="rounded-full bg-zinc-800"
              />
            ) : (
              <SourceInitialAvatar profile={sourceProfile} />
            )}
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-baseline gap-2">
              <h3 className={`min-w-0 font-semibold text-zinc-100 ${isProminent ? 'text-[21px] leading-tight sm:text-[24px]' : 'text-[17px] leading-snug'}`}>
                {youtubeVideo.title || item.title || 'Untitled video'}
              </h3>
              <span className="shrink-0 text-[13px] text-zinc-500">{formatFeedTimestamp(item)}</span>
            </div>

            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[14px] text-zinc-400">
              <span className="font-medium text-zinc-200">{channelLabel}</span>
              {youtubeVideo.channelHandle && youtubeVideo.channelHandle !== channelLabel && (
                <>
                  <span className="text-zinc-600">•</span>
                  <span className="truncate text-zinc-500">{youtubeVideo.channelHandle}</span>
                </>
              )}
            </div>

            {(viewLabel || (youtubeVideo.liveStatus === 'upcoming' && scheduledLabel)) && (
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-zinc-500">
                {viewLabel && <span>{viewLabel}</span>}
                {viewLabel && youtubeVideo.liveStatus === 'upcoming' && scheduledLabel && <span className="text-zinc-700">•</span>}
                {youtubeVideo.liveStatus === 'upcoming' && scheduledLabel && <span>{scheduledLabel}</span>}
              </div>
            )}
            {displayText && !youtubeVideo.liveStatus && (
              <p className={`mt-2 text-zinc-400 ${isProminent ? 'text-[15px] leading-7' : 'text-[14px] leading-relaxed'}`}>
                <HighlightedSearchText text={displayText} searchQuery={bodySearchQuery} />
              </p>
            )}
            {displayText && youtubeVideo.liveStatus && (
              <p className={`mt-2 text-zinc-400 ${isProminent ? 'text-[15px] leading-7' : 'text-[14px] leading-relaxed'}`}>
                <HighlightedSearchText text={displayText} searchQuery={bodySearchQuery} />
              </p>
            )}
            {needsTruncation && displayText && (
              <div className="mt-1">
                <button
                  type="button"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onToggleExpand();
                  }}
                  className="text-sm text-sky-400 hover:text-sky-300"
                >
                  {expanded ? COLLAPSE_LABEL : EXPAND_LABEL}
                </button>
              </div>
            )}
            {actionBar}
            {showReasonInput && (
              <ReasonInput
                signalType={showReasonInput}
                onSubmit={onReasonSubmit}
                onDismiss={onDismissReasonInput}
              />
            )}
          </div>
        </div>
      </div>
    );
  }

  if (fullWidth) {
    return (
      <div className="space-y-4">
        <div className="flex items-start gap-3">
          <div className="flex-shrink-0">
            {articleAvatarUrl ? (
              <ResilientImage
                src={articleAvatarUrl}
                alt={sourceProfile.displayName}
                className="h-12 w-12 rounded-full object-cover"
                loading="eager"
              />
            ) : (
              <SourceInitialAvatar profile={sourceProfile} />
            )}
          </div>

          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2 overflow-hidden">
              <p className="truncate text-lg font-semibold text-zinc-100">{articleHeaderDisplayName}</p>
              <span className="shrink-0 text-zinc-500">·</span>
              <p className="shrink-0 text-sm text-zinc-500">{formatFeedTimestamp(item)}</p>
            </div>
            <p className="text-sm text-zinc-500">{item.source || 'Article'}</p>
          </div>
        </div>

        <h1 className={`font-semibold text-zinc-100 ${detail ? (isProminent ? 'text-[34px] leading-[1.08] sm:text-5xl' : 'text-3xl leading-tight sm:text-4xl') : (isProminent ? 'text-[21px] leading-tight sm:text-[24px]' : 'text-[17px] leading-snug')}`}>
          {item.title || 'Untitled article'}
        </h1>

        {displayText && (
          <div className="relative select-text touch-auto">
            <p className={`whitespace-pre-wrap break-words ${detail ? `text-zinc-200 ${isProminent ? 'text-[18px] leading-8 sm:text-[20px]' : 'text-[17px] leading-8 sm:text-[18px]'}` : `text-zinc-300 ${isProminent ? 'text-[16px] leading-7' : 'text-[15px] leading-relaxed'}`}`}>
              <HighlightedSearchText text={displayText} searchQuery={bodySearchQuery} />
              {needsTruncation && !expanded && (
                <>
                  {'... '}
                  <button
                    type="button"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      onToggleExpand();
                    }}
                    className="text-sky-400 hover:text-sky-300"
                  >
                    {EXPAND_LABEL}
                  </button>
                </>
              )}
              {needsTruncation && expanded && (
                <>
                  {' '}
                  <button
                    type="button"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      onToggleExpand();
                    }}
                    className="text-sky-400 hover:text-sky-300"
                  >
                    {COLLAPSE_LABEL}
                  </button>
                </>
              )}
            </p>
          </div>
        )}

        {actionBar}

        {showReasonInput && (
          <ReasonInput
            signalType={showReasonInput}
            onSubmit={onReasonSubmit}
            onDismiss={onDismissReasonInput}
          />
        )}
      </div>
    );
  }

  return (
    <>
      <div className="flex gap-3">
        <div className="flex-shrink-0">
          {articleAvatarUrl ? (
            <ResilientImage
              src={articleAvatarUrl}
              alt={sourceProfile.displayName}
              className="h-11 w-11 rounded-full object-cover sm:h-12 sm:w-12"
            />
          ) : (
            <SourceInitialAvatar profile={sourceProfile} />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-1.5 overflow-hidden text-[15px]">
              <p className="truncate font-semibold text-zinc-100">{articleHeaderDisplayName}</p>
              <span className="shrink-0 text-zinc-500">·</span>
              <p className="shrink-0 text-zinc-500">{formatFeedTimestamp(item)}</p>
            </div>
            <p className="truncate text-[14px] text-zinc-500">{item.source || 'Article'}</p>
          </div>

          <h3 className={`font-semibold text-zinc-100 ${isProminent ? 'mt-2 text-[21px] leading-tight sm:text-[24px]' : 'mt-0.5 text-[17px] leading-tight'}`}>{item.title || 'Untitled article'}</h3>

          {media.length > 0 && <MediaDisplay media={media} tweetUrl={item.url || undefined} />}

          {displayText && (
            <div className={`relative select-text touch-auto ${isProminent ? 'mt-2' : 'mt-1'}`}>
              <p className={`whitespace-pre-wrap break-words text-zinc-300 ${isProminent ? 'text-[16px] leading-7' : 'text-[15px] leading-normal'}`}>
                <HighlightedSearchText text={displayText} searchQuery={bodySearchQuery} />
                {needsTruncation && !expanded && (
                  <>
                    {'... '}
                    <button
                      type="button"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onToggleExpand();
                      }}
                      className="text-sky-400 hover:text-sky-300"
                    >
                      {EXPAND_LABEL}
                    </button>
                  </>
                )}
                {needsTruncation && expanded && (
                  <>
                    {' '}
                    <button
                      type="button"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onToggleExpand();
                      }}
                      className="text-sky-400 hover:text-sky-300"
                    >
                      {COLLAPSE_LABEL}
                    </button>
                  </>
                )}
              </p>
            </div>
          )}

          {actionBar}

          {showReasonInput && (
            <ReasonInput
              signalType={showReasonInput}
              onSubmit={onReasonSubmit}
              onDismiss={onDismissReasonInput}
            />
          )}
        </div>
      </div>

    </>
  );
}

export function resolveAnalysisDisplayTitle(item: FeedItem): string | null {
  return item.title?.trim() || item.analysisPresentation?.conciseTitle?.trim() || null;
}

export function resolveAnalysisAuthorDisplayName(
  item: Pick<FeedItem, 'authorDisplayName'>,
  agentName: string,
): string {
  return item.authorDisplayName?.trim() || agentName.trim() || 'Evogent';
}

export function resolveAnalysisByline(
  item: Pick<FeedItem, 'authorDisplayName'>,
  agentName: string,
): string {
  const authorDisplayName = item.authorDisplayName?.trim();
  if (authorDisplayName) {
    return authorDisplayName;
  }

  return `${formatPossessive(resolveAnalysisAuthorDisplayName(item, agentName))} analysis`;
}

function AnalysisCard({
  item,
  agentName = 'Evogent',
  childPreviews,
  detail = false,
  isLiked,
  isDisliked,
  votePending,
  onThumbsUp,
  onThumbsDown,
  showReasonInput,
  onReasonSubmit,
  onDismissReasonInput,
  onChat,
  searchQuery,
}: {
  item: FeedItem;
  agentName: string;
  childPreviews?: React.ReactNode;
  detail?: boolean;
  isLiked: boolean;
  isDisliked: boolean;
  votePending: boolean;
  onThumbsUp: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onThumbsDown: (event: React.MouseEvent<HTMLButtonElement>) => void;
  showReasonInput: 'thumbsup' | 'thumbsdown' | null;
  onReasonSubmit: (reason: string) => void;
  onDismissReasonInput: () => void;
  onChat?: (item: FeedItem, selectedText?: string) => void;
  searchQuery?: string | null;
}) {
  const printableBodyRef = useRef<HTMLElement>(null);
  const analysisAuthorDisplayName = resolveAnalysisAuthorDisplayName(item, agentName);
  const sourceProfile = resolveAgentSourceProfile(analysisAuthorDisplayName);
  const analysisDisplayName = resolveAnalysisByline(item, agentName);
  const analysisSourcePreviews = getAnalysisSourcePreviews(item);
  const directMedia = getFeedMediaItems(item);
  const displayMedia = getPreferredFeedMediaItems(item);
  const usesInheritedHeroMedia = directMedia.length === 0 && displayMedia.length > 0;
  const heroMediaSource = item.analysisPresentation?.heroMediaSource;
  const heroMediaSourceLabel = heroMediaSource?.title?.trim()
    || heroMediaSource?.authorDisplayName?.trim()
    || heroMediaSource?.authorUsername?.trim()
    || null;
  const displayText = item.text;
  const bodySearchQuery = searchQuery;
  const isProminent = isProminentFeedItem(item);
  const bodyMarginTopClass = isProminent ? 'mt-5' : 'mt-4';
  const titleClassName = `mt-1 font-bold leading-tight text-zinc-100 ${isProminent ? 'text-3xl sm:text-4xl' : 'text-2xl sm:text-3xl'}`;
  const articleBodyClassName = 'max-w-none text-zinc-200 [&_p]:my-4 [&_p]:text-[17px] [&_p]:leading-[1.45] sm:[&_p]:text-[18px] [&_ul]:my-4 [&_ol]:my-4 [&_li]:text-[17px] [&_li]:leading-[1.45] sm:[&_li]:text-[18px] [&_li]:marker:text-zinc-500 [&_strong]:font-semibold [&_strong]:text-zinc-100 [&_em]:text-zinc-100 [&_blockquote]:my-4 [&_blockquote]:border-l-2 [&_blockquote]:border-zinc-700 [&_blockquote]:pl-4 [&_blockquote]:text-zinc-300 [&_blockquote_p]:text-[17px] [&_blockquote_p]:leading-[1.45] sm:[&_blockquote_p]:text-[18px] [&_h1]:mt-8 [&_h1]:text-3xl [&_h1]:font-bold [&_h1]:leading-tight sm:[&_h1]:text-4xl [&_h2]:mt-8 [&_h2]:text-[22px] [&_h2]:font-semibold [&_h2]:leading-tight sm:[&_h2]:text-[24px] [&_h3]:mt-6 [&_h3]:text-[18px] [&_h3]:font-semibold [&_h3]:leading-tight sm:[&_h3]:text-[20px] [&_h4]:mt-6 [&_h4]:text-[18px] [&_h4]:font-semibold [&_h4]:leading-tight sm:[&_h4]:text-[20px]';
  const hasChildPreviews = Boolean(childPreviews);
  const actionBarClassName = 'mt-6 border-t border-zinc-800/80 pt-3 text-zinc-400';
  const metricsRow = (
    <div className="flex items-center gap-1">
      <MetricButton
        icon={<ThumbsUpIcon filled={isLiked} />}
        count={0}
        hoverColor="group-hover:text-emerald-400 group-hover:bg-emerald-500/10"
        active={isLiked}
        activeColor="text-emerald-400"
        onClick={onThumbsUp}
        disabled={votePending}
        ariaLabel={isLiked ? 'Remove thumbs up' : 'Thumbs up'}
      />
      <MetricButton
        icon={<ThumbsDownIcon filled={isDisliked} />}
        count={0}
        hoverColor="group-hover:text-red-400 group-hover:bg-red-500/10"
        active={isDisliked}
        activeColor="text-red-400"
        onClick={onThumbsDown}
        disabled={votePending}
        ariaLabel={isDisliked ? 'Remove thumbs down' : 'Thumbs down'}
      />
      {onChat && (
        <AgentActionButton
          agentName={analysisAuthorDisplayName}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onChat(item);
          }}
        />
      )}
    </div>
  );
  const displayTitle = resolveAnalysisDisplayTitle(item);
  const printableTitle = item.title?.trim() || displayTitle || analysisDisplayName;
  const mediaBlock = displayMedia.length > 0 ? (
    <div className="mb-4">
      <MediaDisplay media={displayMedia} tweetUrl={item.url || undefined} prominent />
      {usesInheritedHeroMedia && heroMediaSourceLabel && (
        <p className="mt-2 text-xs text-zinc-500">
          Hero media from {heroMediaSourceLabel}
        </p>
      )}
    </div>
  ) : null;

  const handleExportPdf = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();

    const printableBody = printableBodyRef.current;
    if (!printableBody || typeof window === 'undefined' || typeof document === 'undefined') {
      return;
    }

    const printableDocument = buildPrintableDocument({
      title: printableTitle,
      bodyHtml: printableBody.innerHTML,
      sources: analysisSourcePreviews,
    });

    const printWindow = window.open('', '_blank');
    if (printWindow) {
      writePrintableDocument(printWindow, printableDocument);
      return;
    }

    printDocumentWithIframe(printableDocument);
  }, [analysisSourcePreviews, printableTitle]);
  const markdownComponents = useMemo(() => ({
    a: ({ href, children, ...props }: React.ComponentProps<'a'>) => (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-sky-400 hover:text-sky-300 hover:underline"
        onClick={(event) => event.stopPropagation()}
        {...props}
      >
        {highlightReactTextChildren(children, bodySearchQuery)}
      </a>
    ),
    p: ({ children, ...props }: React.ComponentProps<'p'>) => (
      <p {...props}>{highlightReactTextChildren(children, bodySearchQuery)}</p>
    ),
    li: ({ children, ...props }: React.ComponentProps<'li'>) => (
      <li {...props}>{highlightReactTextChildren(children, bodySearchQuery)}</li>
    ),
    strong: ({ children, ...props }: React.ComponentProps<'strong'>) => (
      <strong {...props}>{highlightReactTextChildren(children, bodySearchQuery)}</strong>
    ),
    em: ({ children, ...props }: React.ComponentProps<'em'>) => (
      <em {...props}>{highlightReactTextChildren(children, bodySearchQuery)}</em>
    ),
    h1: ({ children, ...props }: React.ComponentProps<'h1'>) => (
      <h1 {...props}>{highlightReactTextChildren(children, bodySearchQuery)}</h1>
    ),
    h2: ({ children, ...props }: React.ComponentProps<'h2'>) => (
      <h2 {...props}>{highlightReactTextChildren(children, bodySearchQuery)}</h2>
    ),
    h3: ({ children, ...props }: React.ComponentProps<'h3'>) => (
      <h3 {...props}>{highlightReactTextChildren(children, bodySearchQuery)}</h3>
    ),
    h4: ({ children, ...props }: React.ComponentProps<'h4'>) => (
      <h4 {...props}>{highlightReactTextChildren(children, bodySearchQuery)}</h4>
    ),
  }), [bodySearchQuery]);
  const openLinkRow = (
    <div className="flex items-center justify-end gap-2">
      {detail && (
        <ExportPdfButton onClick={handleExportPdf} />
      )}
    </div>
  );

  const body = (
    <>
      <div className="min-w-0">
        {mediaBlock}
        {displayTitle ? (
          <h1 className={titleClassName}>{displayTitle}</h1>
        ) : null}
        <div className="mt-3 flex items-center gap-2.5 text-sm">
          <SourceInitialAvatar profile={sourceProfile} />
          <div className="min-w-0">
            <p className="truncate font-medium text-zinc-300">{analysisDisplayName}</p>
            <p className="text-xs text-zinc-500">{formatFeedTimestamp(item)}</p>
          </div>
        </div>

        <div className={`relative select-text touch-auto ${bodyMarginTopClass}`}>
          <article
            data-testid="analysis-article-body"
            className={articleBodyClassName}
          >
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={markdownComponents}
            >
              {displayText || ''}
            </ReactMarkdown>
          </article>
        </div>

        <div hidden aria-hidden="true">
          <article ref={printableBodyRef}>
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ href, children, ...props }) => (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    {...props}
                  >
                    {children}
                  </a>
                ),
              }}
            >
              {item.text || ''}
            </ReactMarkdown>
          </article>
        </div>
      </div>

      {hasChildPreviews ? (
        <div className={`${actionBarClassName} flex flex-col items-stretch gap-0`}>
          {metricsRow}
          {childPreviews}
          {openLinkRow}
        </div>
      ) : (
        <div className={`${actionBarClassName} flex items-center justify-between`}>
          {metricsRow}
          {openLinkRow}
        </div>
      )}

      {showReasonInput && (
        <div>
          <ReasonInput
            signalType={showReasonInput}
            onSubmit={onReasonSubmit}
            onDismiss={onDismissReasonInput}
          />
        </div>
      )}
    </>
  );

  return (
    <div data-testid="analysis-article-layout">{body}</div>
  );
}

function SuggestionDetailCard({
  item,
  status = 'pending',
  pendingAction = null,
  feedback,
  onAccept,
  onDismiss,
}: {
  item: FeedItem;
  status?: SuggestionStatus;
  pendingAction?: 'accept' | 'dismiss' | null;
  feedback?: string | null;
  onAccept?: (item: FeedItem) => void | Promise<void>;
  onDismiss?: (item: FeedItem) => void | Promise<void>;
}) {
  const disabled = pendingAction !== null;
  const isCodeFix = isCodeFixSuggestion(item);
  const title = item.title || getFeedSuggestionDefaultTitle(item);
  const reason = item.reason?.trim();
  const resolvedFeedback = feedback?.trim() || getSuggestionStatusFeedback(item, status);
  const feedbackTone = resolvedFeedback?.toLowerCase().includes('failed') ? 'text-red-300' : 'text-emerald-300';
  const canAccept = isSuggestionActionable(status);
  const statusClassName = status === 'failed'
    ? 'rounded-full border border-red-700/70 bg-red-900/30 px-2 py-0.5 text-[11px] font-medium text-red-100'
    : status === 'merged' || status === 'accepted'
      ? 'rounded-full border border-emerald-700/70 bg-emerald-900/30 px-2 py-0.5 text-[11px] font-medium text-emerald-100'
      : status === 'dismissed'
        ? 'rounded-full border border-zinc-700/70 bg-zinc-900/40 px-2 py-0.5 text-[11px] font-medium text-zinc-200'
        : 'rounded-full border border-amber-700/70 bg-amber-900/30 px-2 py-0.5 text-[11px] font-medium text-amber-100';
  const avatarClassName = isCodeFix
    ? 'flex h-12 w-12 items-center justify-center rounded-full border border-amber-700/70 bg-amber-950/40 text-sm font-semibold text-amber-100'
    : 'flex h-12 w-12 items-center justify-center rounded-full border border-cyan-700/70 bg-cyan-950/40 text-sm font-semibold text-cyan-100';

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <div className={avatarClassName}>
          {isCodeFix ? '</>' : 'SG'}
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-lg font-semibold text-zinc-100">{getFeedSuggestionLabel(item)}</p>
            <span className={statusClassName}>
              {getSuggestionStatusLabel(status)}
            </span>
          </div>
          <p className="text-sm text-zinc-500">{formatAbsoluteTimestamp(item.publishedAt)}</p>
        </div>
      </div>

      <h1 className="text-3xl font-semibold leading-tight text-zinc-100 sm:text-4xl">{title}</h1>
      <p className="whitespace-pre-wrap text-[17px] leading-8 text-zinc-200 sm:text-[18px]">{item.text}</p>
      {reason ? <p className="text-sm text-zinc-400">{reason}</p> : null}

      <DetailMetadata
        timestamp={formatAbsoluteTimestamp(item.publishedAt)}
        sourceLabel={getFeedSuggestionLabel(item)}
      />

      {canAccept || status === 'dismissed' ? (
        <div className="flex flex-wrap items-center gap-3 border-y border-zinc-800/80 py-3">
          {canAccept ? (
            <>
              <button
                type="button"
                disabled={disabled || !canAccept}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  void onAccept?.(item);
                }}
                className="min-h-11 rounded-full border border-emerald-700 bg-emerald-900/30 px-4 py-2 text-sm font-medium text-emerald-100 transition-colors hover:bg-emerald-900/45 disabled:cursor-not-allowed disabled:opacity-65"
              >
                {getFeedSuggestionAcceptLabel(item, pendingAction === 'accept')}
              </button>
              <button
                type="button"
                disabled={disabled}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  void onDismiss?.(item);
                }}
                className="min-h-11 rounded-full border border-zinc-700 bg-zinc-900/45 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:bg-zinc-900/70 disabled:cursor-not-allowed disabled:opacity-65"
              >
                {pendingAction === 'dismiss' ? 'Dismissing...' : 'Dismiss'}
              </button>
            </>
          ) : (
            <span className="text-sm text-zinc-500">This suggestion is hidden from the feed.</span>
          )}
        </div>
      ) : null}

      {resolvedFeedback ? <p className={`text-sm ${feedbackTone}`}>{resolvedFeedback}</p> : null}
    </div>
  );
}

export function ContentCard({
  item,
  detail = false,
  detailLayout = 'card',
  agentName = 'Agent',
  hideFeedbackActions = false,
  onChat,
  onOpenDetail,
  detailMainItemId = null,
  suppressedChildPreviewIds = [],
  suggestionStatus = 'pending',
  suggestionPendingAction = null,
  suggestionFeedback = null,
  searchQuery = null,
  useSearchSnippet = !detail,
  onSuggestionAccept,
  onSuggestionDismiss,
}: ContentCardProps) {
  const router = useRouter();
  const cardRef = useRef<HTMLElement | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [expandedChildPreviews, setExpandedChildPreviews] = useState<Record<string, boolean>>({});
  const [isLiked, setIsLiked] = useState(item.isLiked);
  const [isDisliked, setIsDisliked] = useState(item.isDisliked);
  const [showReasonInput, setShowReasonInput] = useState<'thumbsup' | 'thumbsdown' | null>(null);
  const [votePending, setVotePending] = useState(false);
  const [tweetLikeDelta, setTweetLikeDelta] = useState(0);
  const [lightboxImageUrl, setLightboxImageUrl] = useState<string | null>(null);
  const [isLightboxOpen, setIsLightboxOpen] = useState(false);
  const [lightboxSession, setLightboxSession] = useState(0);
  const lightboxCloseTimeoutRef = useRef<number | null>(null);
  const enrichmentIndicatorTimeoutRef = useRef<number | null>(null);
  const isHackerNewsItem = isHackerNewsFeedItem(item);
  const batchEnrichmentState = getFeedItemBatchEnrichmentState(item);
  const batchIndicatorState: CardEnrichmentIndicatorState | null = batchEnrichmentState === 'none'
    ? null
    : batchEnrichmentState === 'enriching'
      ? 'enriching'
      : batchEnrichmentState;
  const awaitingEnrichmentMetrics = (item.type === 'tweet' || item.type === 'article')
    && batchIndicatorState === null
    && isAwaitingFullEnrichmentMetrics(item);
  const [enrichmentIndicatorState, setEnrichmentIndicatorState] = useState<CardEnrichmentIndicatorState>(
    batchIndicatorState ?? (awaitingEnrichmentMetrics ? 'enriching' : 'hidden'),
  );
  const wasAwaitingEnrichmentMetricsRef = useRef(awaitingEnrichmentMetrics);

  useEffect(() => {
    setIsLiked(item.isLiked);
  }, [item.id, item.isLiked]);

  useEffect(() => {
    setIsDisliked(item.isDisliked);
  }, [item.id, item.isDisliked]);

  useEffect(() => {
    setTweetLikeDelta(0);
  }, [item.id, item.metrics.likes]);

  useEffect(() => {
    setShowReasonInput(null);
  }, [item.id]);

  useEffect(() => {
    setExpandedChildPreviews({});
  }, [item.id]);

  const handleVote = useCallback(async (
    action: 'thumbsup' | 'thumbsdown' | 'undo_thumbsup' | 'undo_thumbsdown',
    reason?: string,
  ) => {
    if (votePending) return;

    const previousLiked = isLiked;
    const previousDisliked = isDisliked;
    let nextLiked = previousLiked;
    let nextDisliked = previousDisliked;

    if (action === 'thumbsup') {
      nextLiked = true;
      nextDisliked = false;
    } else if (action === 'thumbsdown') {
      nextLiked = false;
      nextDisliked = true;
    } else if (action === 'undo_thumbsup') {
      nextLiked = false;
    } else {
      nextDisliked = false;
    }

    const shouldOptimisticallyIncrementTweetLike = action === 'thumbsup'
      && item.type === 'tweet'
      && !isHackerNewsItem
      && !previousLiked;
    setIsLiked(nextLiked);
    setIsDisliked(nextDisliked);
    if (shouldOptimisticallyIncrementTweetLike) {
      setTweetLikeDelta((current) => current + 1);
    }
    if (action === 'undo_thumbsup' || action === 'undo_thumbsdown') {
      setShowReasonInput(null);
    }

    setVotePending(true);

    try {
      const response = await fetch('/api/interactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          feedItemId: item.id,
          action,
          reason: reason || undefined,
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to update vote state (${response.status})`);
      }

      const data = await response.json() as { shouldPassthroughLike?: boolean };
      if (shouldOptimisticallyIncrementTweetLike && data.shouldPassthroughLike !== true) {
        setTweetLikeDelta((current) => current - 1);
      }

      if (data.shouldPassthroughLike === true) {
        fetch(`/api/feed/${encodeURIComponent(item.id)}/like`, {
          method: 'POST',
        }).catch(() => {});
      }
    } catch {
      setIsLiked(previousLiked);
      setIsDisliked(previousDisliked);
      if (shouldOptimisticallyIncrementTweetLike) {
        setTweetLikeDelta((current) => current - 1);
      }
      if (action === 'thumbsup' || action === 'thumbsdown') {
        setShowReasonInput(null);
      }
    } finally {
      setVotePending(false);
    }
  }, [isDisliked, isHackerNewsItem, isLiked, item.id, item.type, votePending]);

  const handleThumbsUp = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();

    if (isLiked) {
      void handleVote('undo_thumbsup');
      return;
    }

    void handleVote('thumbsup');
  }, [handleVote, isLiked]);

  const handleThumbsDown = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();

    if (isDisliked) {
      void handleVote('undo_thumbsdown');
      return;
    }

    setShowReasonInput('thumbsdown');
    void handleVote('thumbsdown');
  }, [handleVote, isDisliked]);

  const handleReasonSubmit = useCallback((reason: string) => {
    if (showReasonInput && reason.trim()) {
      fetch('/api/interactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          feedItemId: item.id,
          action: showReasonInput,
          reason: reason.trim(),
        }),
      }).catch(() => {});
    }
    setShowReasonInput(null);
  }, [item.id, showReasonInput]);

  const clearLightboxCloseTimeout = useCallback(() => {
    if (lightboxCloseTimeoutRef.current === null) return;
    window.clearTimeout(lightboxCloseTimeoutRef.current);
    lightboxCloseTimeoutRef.current = null;
  }, []);

  const handleImageClick = useCallback((url: string, event: React.MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    clearLightboxCloseTimeout();
    setLightboxSession((current) => current + 1);
    setLightboxImageUrl(url);
    setIsLightboxOpen(true);
  }, [clearLightboxCloseTimeout]);

  const handleLightboxClose = useCallback(() => {
    if (!lightboxImageUrl) return;
    setIsLightboxOpen(false);
    clearLightboxCloseTimeout();
    lightboxCloseTimeoutRef.current = window.setTimeout(() => {
      setLightboxImageUrl(null);
      lightboxCloseTimeoutRef.current = null;
    }, LIGHTBOX_CLOSE_TRANSITION_MS);
  }, [clearLightboxCloseTimeout, lightboxImageUrl]);

  useEffect(() => () => {
    if (lightboxCloseTimeoutRef.current !== null) {
      window.clearTimeout(lightboxCloseTimeoutRef.current);
    }
  }, []);

  const clearEnrichmentIndicatorTimer = useCallback(() => {
    if (enrichmentIndicatorTimeoutRef.current === null) return;
    window.clearTimeout(enrichmentIndicatorTimeoutRef.current);
    enrichmentIndicatorTimeoutRef.current = null;
  }, []);

  useEffect(() => {
    const canShowEnrichmentState = item.type === 'tweet' || item.type === 'article';

    clearEnrichmentIndicatorTimer();

    if (!canShowEnrichmentState) {
      wasAwaitingEnrichmentMetricsRef.current = false;
      setEnrichmentIndicatorState('hidden');
      return;
    }

    const wasAwaitingEnrichmentMetrics = wasAwaitingEnrichmentMetricsRef.current;

    if (batchIndicatorState !== null) {
      wasAwaitingEnrichmentMetricsRef.current = false;
      setEnrichmentIndicatorState(batchIndicatorState);
      return;
    }

    if (awaitingEnrichmentMetrics) {
      wasAwaitingEnrichmentMetricsRef.current = true;
      setEnrichmentIndicatorState('enriching');
      return;
    }

    wasAwaitingEnrichmentMetricsRef.current = false;
    if (wasAwaitingEnrichmentMetrics) {
      setEnrichmentIndicatorState('complete');
      enrichmentIndicatorTimeoutRef.current = window.setTimeout(() => {
        setEnrichmentIndicatorState('hidden');
        enrichmentIndicatorTimeoutRef.current = null;
      }, ENRICHMENT_COMPLETE_VISIBILITY_MS);
      return;
    }

    setEnrichmentIndicatorState('hidden');
  }, [awaitingEnrichmentMetrics, batchIndicatorState, clearEnrichmentIndicatorTimer, item.type]);

  useEffect(() => () => {
    clearEnrichmentIndicatorTimer();
  }, [clearEnrichmentIndicatorTimer]);

  const isFullWidthDetail = detailLayout === 'full-width';
  const isCardInteractive = !detail || Boolean(onOpenDetail);
  const cardClass = resolveContentCardOuterClass({
    detailLayout,
    relationship: item.relationship,
    detailMainItemId,
  });

  const metricsLikes = Math.max(0, item.metrics.likes + tweetLikeDelta);
  const shouldOpenDetail = () => {
    const selection = typeof window !== 'undefined' ? window.getSelection() : null;
    const hasSelection = !!selection && selection.toString().trim().length > 0;
    return !hasSelection;
  };
  const openFeedItemDetail = useCallback((feedItem: FeedItem) => {
    if (onOpenDetail) {
      onOpenDetail(feedItem);
      return;
    }

    const routeId = encodeURIComponent(resolvePostRouteId(feedItem));
    router.push(`/post/${routeId}`);
  }, [onOpenDetail, router]);
  const handleQuoteTweetClick = useCallback(async (quote: QuoteTweet) => {
    const quoteIdentifier = quote.id?.trim() || quote.url?.trim() || null;
    const fallbackUrl = quote.url?.trim() || (quote.id?.trim() ? `https://x.com/i/web/status/${quote.id.trim()}` : null);

    if (!quoteIdentifier) return;

    try {
      const response = await fetch(`/api/feed/${encodeURIComponent(quoteIdentifier)}`, { cache: 'no-store' });
      if (response.ok) {
        const payload = await response.json() as { item?: FeedItem };
        if (payload.item?.id) {
          openFeedItemDetail(payload.item);
          return;
        }
      }
    } catch {
      // Fallback handled below.
    }

    if (fallbackUrl) {
      window.open(fallbackUrl, '_blank', 'noopener,noreferrer');
    }
  }, [openFeedItemDetail]);
  const handleCardAskAgent = useCallback((selectedText: string) => {
    onChat?.(item, selectedText);
  }, [item, onChat]);
  const parentTweet = item.type === 'tweet'
    ? (item.parentItem ?? null)
    : null;
  const childPreviews = item.children ?? [];
  const suppressedChildPreviewIdSet = useMemo(
    () => new Set(suppressedChildPreviewIds),
    [suppressedChildPreviewIds],
  );
  const filteredChildPreviews = childPreviews.filter((child) => {
    if (parentTweet && child.relationship === 'parent') {
      return false;
    }

    if (child.relationship === 'analysis' && suppressedChildPreviewIdSet.has(child.id)) {
      return false;
    }

    return true;
  });
  const searchAwareChildPreviews = sortChildPreviewsForSearch(filteredChildPreviews, searchQuery);
  const visibleChildPreviews = searchAwareChildPreviews.slice(0, 3);
  const renderedChildPreviews = visibleChildPreviews;
  const suppressedChildPreviewCount = childPreviews.length - filteredChildPreviews.length;
  const resolvedChildPreviewTotal = Math.max(
    0,
    Math.max(item.childrenCount ?? 0, childPreviews.length) - suppressedChildPreviewCount,
  );
  const hiddenChildPreviewCount = Math.max(0, resolvedChildPreviewTotal - visibleChildPreviews.length);
  const showChildPreviews = shouldRenderContentCardChildPreviews({
    itemId: item.id,
    detailMainItemId,
    hasChildPreviews: renderedChildPreviews.length > 0 || hiddenChildPreviewCount > 0,
  });
  const showParentTweetPreview = shouldRenderContentCardParentTweetPreview(parentTweet, detailMainItemId);
  const suggestionSearchSnippet = item.type === 'suggestion' && searchQuery
    ? buildSearchSnippet(item.text, searchQuery, 220)
    : null;
  const suggestionText = suggestionSearchSnippet?.hasMatch ? suggestionSearchSnippet.text : item.text;
  const childPreviewContent = showChildPreviews ? (
    <div className="mt-1.5 space-y-2 border-t border-zinc-800 pt-2">
      {renderedChildPreviews.map((child) => {
        if (child.type === 'analysis') {
          const isAnalysisExpanded = expandedChildPreviews[child.id] ?? false;

          return (
            <ChildAnalysisPreview
              key={child.id}
              item={child}
              agentName={agentName}
              expanded={isAnalysisExpanded}
              searchQuery={searchQuery}
              onToggleExpand={() => {
                setExpandedChildPreviews((current) => ({ ...current, [child.id]: !isAnalysisExpanded }));
              }}
            />
          );
        }

        if (child.relationship === 'reply') {
          const isReplyExpanded = expandedChildPreviews[child.id] ?? false;

          return (
            <ReplyTweetPreview
              key={child.id}
              item={child}
              expanded={isReplyExpanded}
              searchQuery={searchQuery}
              onToggleExpand={() => {
                setExpandedChildPreviews((current) => ({ ...current, [child.id]: !isReplyExpanded }));
              }}
            />
          );
        }

        return (
          <div key={child.id} className="flex items-center gap-2 py-1.5 text-sm text-zinc-400">
            <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-zinc-600">
              {labelForRelationship(child.relationship)}
            </span>
            <span className="min-w-0 truncate text-zinc-300">
              <HighlightedSearchText text={previewLineText(child)} searchQuery={searchQuery} />
            </span>
          </div>
        );
      })}
      {hiddenChildPreviewCount > 0 && (
        <p className="py-1 text-xs text-zinc-500">+{hiddenChildPreviewCount} more</p>
      )}
    </div>
  ) : null;

  return (
    <article
      ref={cardRef}
      data-testid="content-card"
      data-item-type={item.type}
      data-item-id={item.id}
      data-feed-item-id={item.id}
      data-feed-item-type={item.type}
      data-detail={detail ? 'true' : 'false'}
      data-detail-layout={detailLayout}
      data-prominence={item.metadata?.prominence?.level}
      data-liked={String(isLiked)}
      data-disliked={String(isDisliked)}
      role={isCardInteractive ? 'link' : undefined}
      tabIndex={isCardInteractive ? 0 : undefined}
      className={`${cardClass} ${isCardInteractive ? 'cursor-pointer' : ''}`}
      onClick={() => {
        if (isCardInteractive && shouldOpenDetail()) {
          openFeedItemDetail(item);
        }
      }}
      onKeyDown={(event) => {
        if (!isCardInteractive) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openFeedItemDetail(item);
        }
      }}
    >
      <div className="pointer-events-none absolute right-3 top-3 z-10">
        <CompactEnrichmentIndicator state={enrichmentIndicatorState} />
      </div>

      {item.type === 'tweet' && (
        <div className="relative">
          {showParentTweetPreview && parentTweet && (
            <div className="relative z-10 pb-3 pl-2">
              <div
                aria-hidden="true"
                className="pointer-events-none absolute bottom-0 left-[22px] top-[22px] z-0 w-[2px] -translate-x-1/2 bg-zinc-600 sm:left-[24px] sm:top-[24px]"
              />
              <ParentTweetPreview
                item={parentTweet}
                onOpen={() => openFeedItemDetail(item)}
                searchQuery={searchQuery}
              />
            </div>
          )}
          <div className="relative z-10">
            <TweetCard
              item={item}
              agentName={agentName}
              showQuoteMetrics={detail}
              childPreviews={childPreviewContent}
              fullWidth={isFullWidthDetail}
              hideFeedbackActions={hideFeedbackActions}
              isLiked={isLiked}
              isDisliked={isDisliked}
              votePending={votePending}
              metricsLikes={metricsLikes}
              onThumbsUp={handleThumbsUp}
              onThumbsDown={handleThumbsDown}
              expanded={isExpanded}
              onToggleExpand={() => setIsExpanded((current) => !current)}
              showReasonInput={showReasonInput}
              onReasonSubmit={handleReasonSubmit}
              onDismissReasonInput={() => setShowReasonInput(null)}
              onImageClick={handleImageClick}
              onQuoteTweetClick={handleQuoteTweetClick}
              onChat={onChat}
              searchQuery={searchQuery}
              useSearchSnippet={useSearchSnippet}
            />
          </div>
        </div>
      )}

      {item.type === 'article' && (
        <ArticleCard
          item={item}
          agentName={agentName}
          childPreviews={childPreviewContent}
          fullWidth={true}
          detail={isFullWidthDetail}
          isLiked={isLiked}
          isDisliked={isDisliked}
          votePending={votePending}
          onThumbsUp={handleThumbsUp}
          onThumbsDown={handleThumbsDown}
          expanded={isExpanded}
          onToggleExpand={() => setIsExpanded((current) => !current)}
          showReasonInput={showReasonInput}
          onReasonSubmit={handleReasonSubmit}
          onDismissReasonInput={() => setShowReasonInput(null)}
          onChat={onChat}
          searchQuery={searchQuery}
          useSearchSnippet={useSearchSnippet}
        />
      )}

      {item.type === 'analysis' && !detail && (
        <ArticleCard
          item={item}
          agentName={agentName}
          childPreviews={childPreviewContent}
          fullWidth={true}
          detail={false}
          isLiked={isLiked}
          isDisliked={isDisliked}
          votePending={votePending}
          onThumbsUp={handleThumbsUp}
          onThumbsDown={handleThumbsDown}
          expanded={isExpanded}
          onToggleExpand={() => setIsExpanded((current) => !current)}
          showReasonInput={showReasonInput}
          onReasonSubmit={handleReasonSubmit}
          onDismissReasonInput={() => setShowReasonInput(null)}
          onChat={onChat}
          searchQuery={searchQuery}
          useSearchSnippet={useSearchSnippet}
        />
      )}

      {item.type === 'analysis' && detail && (
        <AnalysisCard
          item={item}
          agentName={agentName}
          childPreviews={childPreviewContent}
          detail={true}
          isLiked={isLiked}
          isDisliked={isDisliked}
          votePending={votePending}
          onThumbsUp={handleThumbsUp}
          onThumbsDown={handleThumbsDown}
          showReasonInput={showReasonInput}
          onReasonSubmit={handleReasonSubmit}
          onDismissReasonInput={() => setShowReasonInput(null)}
          onChat={onChat}
          searchQuery={searchQuery}
        />
      )}

      {item.type === 'suggestion' && (
        isFullWidthDetail ? (
          <SuggestionDetailCard
            item={item}
            status={suggestionStatus}
            pendingAction={suggestionPendingAction}
            feedback={suggestionFeedback}
            onAccept={onSuggestionAccept}
            onDismiss={onSuggestionDismiss}
          />
        ) : (
          <>
            <div className="mb-2 flex items-center gap-2">
              <span className="rounded-full border border-cyan-700/70 bg-cyan-900/30 px-2 py-0.5 text-[11px] font-medium text-cyan-200">
                Suggestion
              </span>
              <span className="text-xs text-zinc-500">{formatFeedTimestamp(item)}</span>
            </div>
            {item.title && <h3 className="text-base font-semibold text-zinc-100">{item.title}</h3>}
            <p className="mt-2 whitespace-pre-wrap text-sm text-zinc-300">
              <HighlightedSearchText
                text={suggestionText}
                searchQuery={suggestionSearchSnippet?.hasMatch ? searchQuery : null}
              />
            </p>
          </>
        )
      )}

      <TextSelectionTooltip
        agentName={agentName}
        containerRef={cardRef}
        onAskAgent={onChat ? handleCardAskAgent : undefined}
      />

      <ImageLightbox
        key={`${lightboxSession}-${lightboxImageUrl || 'empty'}`}
        imageUrl={lightboxImageUrl}
        isOpen={isLightboxOpen}
        onRequestClose={handleLightboxClose}
      />
    </article>
  );
}
