import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  getFeedSuggestionBatchSummary,
  getSuggestionStatusFeedback,
  getFeedSuggestionGroupPreview,
  getFeedSuggestionTypeBadgeLabel,
} from './feed-suggestions';
import type { FeedItem } from '@/types/feed';

function createSuggestion(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    id: 'suggestion-1',
    type: 'suggestion',
    source: 'test',
    sourceId: 'source-1',
    parentId: null,
    relationship: null,
    title: null,
    text: 'Default summary.',
    url: null,
    excerpt: null,
    authorUsername: null,
    authorDisplayName: null,
    reason: null,
    tags: [],
    mediaUrls: [],
    metrics: {
      likes: 0,
      reposts: 0,
      replies: 0,
    },
    authorAvatarUrl: null,
    isLiked: false,
    isDisliked: false,
    metadata: {
      suggestionType: 'code_fix',
    },
    publishedAt: '2026-03-16T00:00:00.000Z',
    createdAt: '2026-03-16T00:00:00.000Z',
    ...overrides,
  };
}

describe('feed suggestion helpers', () => {
  test('uses the first sentence for the grouped preview when it is short enough', () => {
    const item = createSuggestion({
      text: 'Tighten the summary style in the curation prompt. This second sentence should not appear.',
    });

    assert.equal(
      getFeedSuggestionGroupPreview(item),
      'Tighten the summary style in the curation prompt.',
    );
  });

  test('falls back to a truncated preview for long single-sentence summaries', () => {
    const item = createSuggestion({
      text: 'This suggestion keeps going without a sentence break so the grouped card should shorten it to a compact preview that is easy to scan quickly',
    });

    assert.equal(
      getFeedSuggestionGroupPreview(item),
      'This suggestion keeps going without a sentence break so the grouped card should...',
    );
  });

  test('returns specific badge labels and aggregate counts by suggestion type', () => {
    const genericItem = createSuggestion({
      metadata: {
        suggestionType: 'other',
      },
    });
    const codeFixItem = createSuggestion({
      id: 'suggestion-2',
      metadata: {
        suggestionType: 'code_fix',
      },
    });

    assert.equal(getFeedSuggestionTypeBadgeLabel(genericItem), 'Suggestion');
    assert.equal(getFeedSuggestionTypeBadgeLabel(codeFixItem), 'Code Fix');
    assert.equal(
      getFeedSuggestionBatchSummary([genericItem, genericItem, codeFixItem]),
      '1 code fix, 2 suggestions',
    );
  });

  test('surfaces explicit code-fix failure metadata in failed feedback', () => {
    const codeFixItem = createSuggestion({
      metadata: {
        suggestionType: 'code_fix',
        incidentKey: 'dev-agent:provider-binary-missing:codex',
        codeFixFailure: {
          category: 'provider_binary_missing',
          fingerprint: 'dev-agent:provider-binary-missing:codex',
          incidentKey: 'dev-agent:provider-binary-missing:codex',
          summary: 'Unrecoverable failure: codex CLI is missing or unavailable.',
          phase: 'agent_execution',
          error: 'codex: command not found',
          terminal: true,
          autoRepairEligible: true,
          repair: {
            suggestionId: 'repair-1',
            taskId: 'fix-repair-1',
            status: 'running',
          },
        },
      },
    });

    assert.equal(
      getSuggestionStatusFeedback(codeFixItem, 'failed'),
      'Unrecoverable failure: codex CLI is missing or unavailable. Incident: dev-agent:provider-binary-missing:codex. Repair task fix-repair-1 is active.',
    );
  });
});
