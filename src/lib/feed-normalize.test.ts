import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareThreadGroupItems } from './feed-render-entries';
import {
  getThreadDisplayGroupIdentity,
  getThreadGroupIdentity,
  isReflectionFeedItem,
  shouldIncludeConversationTimelineEntry,
} from './feed-normalize';
import type { FeedItem } from '@/types/feed';

function item(id: string, createdAt: string, displayOrder: number | null = null): FeedItem {
  return {
    id,
    type: 'article',
    source: 'unit_test',
    sourceId: null,
    originSessionId: null,
    parentId: null,
    relationship: null,
    title: id,
    text: id,
    url: null,
    excerpt: null,
    authorUsername: null,
    authorDisplayName: null,
    reason: null,
    tags: [],
    mediaUrls: [],
    displayOrder,
    threadId: 'thread-a',
    displaySubtitle: null,
    threadTitle: 'Thread A',
    threadSubtitle: null,
    metrics: { likes: 0, reposts: 0, replies: 0 },
    authorAvatarUrl: null,
    isLiked: false,
    isDisliked: false,
    suggestionStatus: undefined,
    analysisPresentation: null,
    metadata: {},
    publishedAt: createdAt,
    createdAt,
  };
}

test('compareThreadGroupItems honors fresh curator display order inside threads', () => {
  const olderPromoted = item('older-promoted', '2026-05-01T00:00:00.000Z', 1);
  const newerLower = item('newer-lower', '2026-05-02T00:00:00.000Z', 2);

  assert.equal(compareThreadGroupItems(olderPromoted, newerLower), -1);
});

test('compareThreadGroupItems preserves newest-first thread fallback without display order', () => {
  const older = item('older', '2026-05-01T00:00:00.000Z');
  const newer = item('newer', '2026-05-02T00:00:00.000Z');

  assert.deepEqual([older, newer].sort(compareThreadGroupItems).map((entry) => entry.id), ['newer', 'older']);
});


test('getThreadDisplayGroupIdentity coalesces duplicate visible thread lanes', () => {
  const first = item('first-one-off', '2026-05-01T00:00:00.000Z');
  const second = item('second-one-off', '2026-05-01T00:01:00.000Z');
  first.threadId = 'one-offs-a';
  second.threadId = 'one-offs-b';
  first.threadTitle = 'One-offs';
  second.threadTitle = 'One-offs';
  first.threadSubtitle = "Strong items outside today’s lanes.";
  second.threadSubtitle = "Sharp edges worth keeping";

  assert.notEqual(getThreadGroupIdentity(first)?.key, getThreadGroupIdentity(second)?.key);
  assert.equal(getThreadDisplayGroupIdentity(first)?.key, getThreadDisplayGroupIdentity(second)?.key);
});

test('getThreadDisplayGroupIdentity keeps non-one-off subtitle lanes separate', () => {
  const first = item('first-security', '2026-05-01T00:00:00.000Z');
  const second = item('second-security', '2026-05-01T00:01:00.000Z');
  first.threadId = 'security-a';
  second.threadId = 'security-b';
  first.threadTitle = 'Security hides in defaults';
  second.threadTitle = 'Security hides in defaults';
  first.threadSubtitle = 'Small rules stop real failures.';
  second.threadSubtitle = 'Supply chain updates need review.';

  assert.notEqual(getThreadGroupIdentity(first)?.key, getThreadGroupIdentity(second)?.key);
  assert.notEqual(getThreadDisplayGroupIdentity(first)?.key, getThreadDisplayGroupIdentity(second)?.key);
});

test('getThreadGroupIdentity ignores archived metadata when thread display is disabled', () => {
  const archived = item('archived-metadata-thread', '2026-05-01T00:00:00.000Z');
  archived.threadDisplayEnabled = false;
  archived.threadId = null;
  archived.threadTitle = null;
  archived.threadSubtitle = null;
  archived.metadata = {
    thread: {
      threadId: 'old-thread',
      threadTitle: 'Old curator lane',
      threadRationale: 'No longer in the live arrange',
    },
  };

  assert.equal(getThreadGroupIdentity(archived), null);
  assert.equal(getThreadDisplayGroupIdentity(archived), null);
});

test('getThreadGroupIdentity trusts live arrangement when metadata has an old thread', () => {
  const demoted = item('demoted-metadata-thread', '2026-05-01T00:00:00.000Z');
  demoted.threadDisplayEnabled = true;
  demoted.threadId = null;
  demoted.threadTitle = null;
  demoted.threadSubtitle = null;
  demoted.metadata = {
    thread: {
      threadId: 'old-thread',
      threadTitle: 'Old curator lane',
      threadRationale: 'No longer in the live arrange',
    },
  };

  assert.equal(getThreadGroupIdentity(demoted), null);
  assert.equal(getThreadDisplayGroupIdentity(demoted), null);
});

test('getThreadGroupIdentity still supports legacy metadata without live arrangement state', () => {
  const legacy = item('legacy-metadata-thread', '2026-05-01T00:00:00.000Z');
  legacy.threadId = null;
  legacy.threadTitle = null;
  legacy.threadSubtitle = null;
  legacy.metadata = {
    thread: {
      threadId: 'metadata-thread',
      threadTitle: 'Metadata curator lane',
      threadRationale: 'Pre-arrangement thread shape',
    },
  };

  assert.equal(getThreadGroupIdentity(legacy)?.threadId, 'metadata-thread');
  assert.equal(getThreadDisplayGroupIdentity(legacy)?.threadId, 'metadata-thread');
});

test('shouldIncludeConversationTimelineEntry excludes empty sessions outside the agent filter', () => {
  const nowMs = Date.parse('2026-06-10T12:00:00.000Z');
  const base = {
    selectedFilter: 'all' as const,
    oldestLoadedPrimaryFeedItemTimestamp: '2026-04-22T00:00:00.000Z',
    conversationLastTimestamp: '2026-06-10T11:00:00.000Z',
    nowMs,
  };

  assert.equal(shouldIncludeConversationTimelineEntry({ ...base, conversationMessageCount: 0 }), false);
  assert.equal(shouldIncludeConversationTimelineEntry({ ...base, conversationMessageCount: 12 }), true);
  assert.equal(shouldIncludeConversationTimelineEntry({
    ...base,
    selectedFilter: 'agent',
    conversationMessageCount: 0,
  }), true);
});

test('shouldIncludeConversationTimelineEntry excludes long-idle sessions outside the agent filter', () => {
  const nowMs = Date.parse('2026-06-10T12:00:00.000Z');
  const base = {
    selectedFilter: 'all' as const,
    oldestLoadedPrimaryFeedItemTimestamp: '2026-04-22T00:00:00.000Z',
    conversationMessageCount: 40,
    nowMs,
  };

  // 20 days idle: out, even though it is newer than the oldest loaded carry-forward item.
  assert.equal(shouldIncludeConversationTimelineEntry({
    ...base,
    conversationLastTimestamp: '2026-05-21T12:00:00.000Z',
  }), false);
  // Active within the last 48h: in.
  assert.equal(shouldIncludeConversationTimelineEntry({
    ...base,
    conversationLastTimestamp: '2026-06-09T13:00:00.000Z',
  }), true);
  // Agent filter always shows sessions regardless of idleness.
  assert.equal(shouldIncludeConversationTimelineEntry({
    ...base,
    selectedFilter: 'agent',
    conversationLastTimestamp: '2026-05-21T12:00:00.000Z',
  }), true);
});

test('isReflectionFeedItem detects all reflection metadata shapes', () => {
  const legacyShape = item('legacy-reflection', '2026-06-10T00:00:00.000Z');
  legacyShape.type = 'analysis';
  legacyShape.metadata = { reflectionCycle: true };

  const modeShape = item('mode-reflection', '2026-06-10T00:00:00.000Z');
  modeShape.type = 'analysis';
  modeShape.metadata = { mode: 'reflection' };

  const idShape = item('reflection-20260610T1114Z-f8e1523a', '2026-06-10T00:00:00.000Z');
  idShape.type = 'analysis';
  idShape.metadata = {};

  const editorialAnalysis = item('curate-20260610-analysis-1', '2026-06-10T00:00:00.000Z');
  editorialAnalysis.type = 'analysis';
  editorialAnalysis.metadata = { bridge: 'A concrete claim with sources.' };

  const reflectionTitledTweet = item('reflection-id-but-tweet', '2026-06-10T00:00:00.000Z');
  reflectionTitledTweet.type = 'tweet';

  assert.equal(isReflectionFeedItem(legacyShape), true);
  assert.equal(isReflectionFeedItem(modeShape), true);
  assert.equal(isReflectionFeedItem(idShape), true);
  assert.equal(isReflectionFeedItem(editorialAnalysis), false);
  assert.equal(isReflectionFeedItem(reflectionTitledTweet), false);
});
