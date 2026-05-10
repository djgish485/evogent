import type { ChatMessage } from './chat';
import type { ConversationSessionSummary } from './conversation';

export type FeedItemType = 'tweet' | 'article' | 'analysis' | 'suggestion' | 'notification';
export type FeedPendingCounts = Record<FeedItemType, number>;
export type FeedRelationship = 'parent' | 'child' | 'reply' | 'analysis' | 'related' | 'thread';
export type FeedProminenceLevel = 'prominent' | 'lead';
export type SuggestionStatus =
  | 'pending'
  | 'accepted'
  | 'dismissed'
  | 'dispatched'
  | 'running'
  | 'merged'
  | 'failed';
export type NotificationSeverity = 'info' | 'warning' | 'error';

export interface CodeFixRepairLink {
  suggestionId: string | null;
  taskId: string | null;
  status: SuggestionStatus | null;
}

export interface CodeFixFailureMetadata {
  category: string;
  fingerprint: string;
  incidentKey: string | null;
  summary: string;
  phase: string | null;
  error: string | null;
  terminalReason?: string | null;
  evidence?: string | null;
  terminal: boolean;
  autoRepairEligible: boolean;
  repair: CodeFixRepairLink | null;
  callbackStatus?: 'queued' | 'sent' | 'skipped' | 'notification' | 'failed' | string;
  callbackFingerprint?: string;
  callbackQueuedAt?: string;
  callbackUpdatedAt?: string;
  callbackMessageId?: string | null;
  callbackError?: string;
  notificationId?: string;
  originSessionId?: string;
}

export interface ChildPreview {
  id: string;
  type: string;
  relationship: string;
  title: string | null;
  text: string;
  source: string | null;
  authorUsername: string | null;
  authorDisplayName: string | null;
  authorAvatarUrl: string | null;
  publishedAt?: string | null;
}

export interface FeedMetrics {
  likes: number;
  reposts: number;
  replies: number;
  views?: number;
}

export interface MediaItem {
  type: 'image' | 'video' | 'gif';
  url: string;
  alt?: string;
  videoUrl?: string;
  posterUrl?: string;
  width?: number;
  height?: number;
  durationMs?: number;
}

export type FeedMediaType = 'photo' | 'video' | 'animated_gif';

export interface TweetCommunityNote {
  text: string;
  sourceUrl?: string;
}

export interface Poll {
  options: Array<{
    label: string;
    voteCount?: number;
  }>;
  totalVotes?: number;
  durationMinutes?: number;
  endsAt?: string;
}

export interface QuoteTweet {
  id?: string;
  text: string;
  author: {
    username: string;
    name?: string;
    displayName?: string;
    avatarUrl?: string;
  };
  metrics?: FeedMetrics;
  media?: MediaItem[];
  url?: string;
  publishedAt?: string;
  communityNote?: TweetCommunityNote;
  linkCard?: LinkCard;
  poll?: Poll;
}

export interface LinkCard {
  type: string;
  url: string;
  title: string;
  domain: string;
  imageUrl?: string;
  imageAlt?: string;
  videoId?: string;
  description?: string;
}

export interface LinkPreview {
  url: string;
  title: string;
  domain: string;
  image?: string;
  imageAlt?: string;
  description?: string;
}

export interface ReplyCaptureMetadata {
  source: 'timeline' | 'search' | 'profile_tweets' | 'profile_with_replies' | 'status_thread' | 'status_replies';
  classification: 'confirmed' | 'candidate' | 'none';
  requestedHandle?: string;
  authoredByRequestedAccount?: boolean;
  visibleReplyBanner?: boolean;
}

export interface FeedReferenceItem {
  id: string;
  type: FeedItemType;
  title: string | null;
  text: string;
  url: string | null;
  source: string | null;
  authorDisplayName: string | null;
  authorUsername: string | null;
}

export interface FeedProminence {
  level: FeedProminenceLevel;
  label?: string;
  source?: string;
  evidence?: string;
  homepageUrl?: string;
}

export interface FeedThreadMetadata extends Record<string, unknown> {
  threadId: string;
  threadTitle?: string;
  threadRationale?: string;
  color?: string;
  continuing?: boolean;
  prominence?: FeedProminence;
}

export interface FeedbackProbeOptions {
  moreLabel?: string;
  lessLabel?: string;
  positiveLabel?: string;
  negativeLabel?: string;
}

export interface FeedbackProbeMetadata {
  reason?: string;
  uncertainty?: string;
  category?: string;
  options?: FeedbackProbeOptions;
  sourceItemIds?: string[];
}

export interface AnalysisPresentation {
  conciseTitle: string | null;
  conciseLabel: string;
  promotionScore: number;
  seriesKey: string | null;
  seriesLabel: string | null;
  heroMedia: MediaItem[];
  heroMediaSource: FeedReferenceItem | null;
  sourceItems: FeedReferenceItem[];
}

export interface FeedMetadata {
  [key: string]: unknown;
  agentProvider?: 'claude' | 'codex';
  cycleId?: string;
  incidentKey?: string;
  inReplyToStatusId?: string;
  conversationId?: string;
  thread?: FeedThreadMetadata;
  riskyTake?: {
    reason: string;
  };
  currentInterestReason?: string;
  bridge?: string;
  prominence?: FeedProminence;
  feedbackProbe?: FeedbackProbeMetadata;
  replyCapture?: ReplyCaptureMetadata;
  media?: MediaItem[];
  mediaTypes?: FeedMediaType[];
  communityNote?: TweetCommunityNote;
  quotedTweet?: QuoteTweet;
  linkCard?: LinkCard;
  poll?: Poll;
  linkPreviews?: LinkPreview[];
  article?: Record<string, unknown>;
  layoutMode?: 'agent-session' | string;
  mcpAppHtml?: string;
  articleEnrichment?: {
    status?: 'completed' | 'skipped' | 'failed';
    completedAt?: string;
    failedAt?: string;
    retryEligible?: boolean;
    skipReason?: string;
    failureReason?: string;
    sourceUrl?: string;
  };
  suggestionType?: string;
  reflectionCycle?: boolean;
  configField?: string;
  configFile?: string;
  proposedValue?: string;
  taskId?: string;
  taskSummary?: string;
  codeFixTaskFamily?: string;
  codeFixAttemptNumber?: number;
  codeFixRetryOfTaskId?: string;
  codeFixPreviousTaskId?: string;
  suggestionStatus?: SuggestionStatus;
  acceptedAt?: string;
  acceptedLineage?: 'explicit' | 'missing' | string;
  acceptedTarget?: string;
  acceptedSnapshotId?: string;
  acceptedSnapshotPath?: string;
  acceptedSnapshotHash?: string;
  codeFixImpactFiles?: string[];
  codeFixOrchestratorBatchId?: string;
  codeFixOrchestratorStatus?: string;
  codeFixBlockedByTaskId?: string;
  codeFixFailure?: CodeFixFailureMetadata;
  configApplyStatus?: string;
  configApplyError?: string;
  diff?: string | null;
  chatMessageId?: string;
  chatReplyToMessageId?: string;
  chatSuggestionIndex?: number;
  severity?: NotificationSeverity;
  autoResolveCondition?: string;
  expiresAt?: string;
  dismissable?: boolean;
  notificationId?: string;
  fullEnrichmentRequestId?: string;
  batchEnrichment?: {
    requestId?: string;
    status?: 'queued' | 'running' | 'completed' | 'failed';
    queuedAt?: string;
    startedAt?: string;
    deadlineAt?: string;
    completedAt?: string;
    failedAt?: string;
    itemIndex?: number;
    itemCount?: number;
    retryEligible?: boolean;
    failureReason?: string;
    replyAudit?: {
      batchRequestId?: string;
      inspectedReplySurface?: boolean;
      inspectedCommentSurface?: boolean;
      sourceReplyCount?: number;
      visibleReplyCount?: number;
      savedReplyCount?: number;
      savedReplyIds?: string[];
      noMeaningfulRepliesReason?: string;
      inspectedAt?: string;
    };
  };
  urlEntities?: Array<{
    url: string;
    expandedUrl?: string;
    displayUrl?: string;
  }>;
  likeCount?: number;
  repostCount?: number;
  replyCount?: number;
  viewCount?: number;
  viewCountText?: string;
  isRetweet?: boolean;
  retweetedBy?: {
    username?: string;
    displayName?: string;
  };
  repairCoordinator?: boolean;
  repairOriginSuggestionId?: string;
  repairOriginTaskId?: string;
}

export interface NotificationTaskContext {
  taskId: string;
  state: 'queued' | 'processing' | 'completed' | 'failed' | null;
  updatedAt: string | null;
  summary: string | null;
  lines: string[];
}

export interface FeedItem {
  id: string;
  type: FeedItemType;
  source: string | null;
  sourceId: string | null;
  originSessionId?: string | null;
  parentId: string | null;
  relationship: FeedRelationship | null;
  title: string | null;
  text: string;
  url: string | null;
  excerpt: string | null;
  authorUsername: string | null;
  authorDisplayName: string | null;
  reason: string | null;
  tags: string[];
  mediaUrls: string[];
  metrics: FeedMetrics;
  authorAvatarUrl: string | null;
  isLiked: boolean;
  isDisliked: boolean;
  suggestionStatus?: SuggestionStatus;
  parentItem?: FeedItem | null;
  children?: ChildPreview[];
  childrenCount?: number;
  suggestionChildren?: FeedItem[];
  analysisPresentation?: AnalysisPresentation | null;
  notificationTaskContext?: NotificationTaskContext | null;
  metadata: FeedMetadata | null;
  publishedAt: string;
  createdAt: string;
}

export interface FeedSuggestionGroup {
  title: string;
  items: FeedItem[];
  latestTimestamp: string | null;
  totalCount: number;
}

export interface FeedPage {
  items: FeedItem[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

export interface ChatSessionSearchMatch {
  sessionId: string;
  latestMessageId: string;
  latestMessageTimestamp: string;
  messages: ChatMessage[];
  session: ConversationSessionSummary | null;
}

export interface FeedListResponse {
  items: FeedItem[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  pendingCounts?: Partial<FeedPendingCounts>;
  suggestionGroup?: FeedSuggestionGroup | null;
  chatSessionMatches?: ChatSessionSearchMatch[];
}
