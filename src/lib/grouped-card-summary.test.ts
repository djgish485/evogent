import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildGroupedCardSummary,
  serializeGroupedCardSummaryRequest,
  type GroupedCardSummaryItem,
} from './grouped-card-summary';

function createSuggestionItem(overrides: Partial<GroupedCardSummaryItem> = {}): GroupedCardSummaryItem {
  return {
    id: 'suggestion-1',
    type: 'suggestion',
    source: 'claude',
    originSessionId: null,
    suggestionStatus: 'pending',
    title: 'Suggested update',
    text: 'Tighten the grouped suggestion summary.',
    reason: null,
    metadata: {
      suggestionType: 'code_fix',
      configFile: 'data/config.md',
    },
    ...overrides,
  };
}

function createNotificationItem(overrides: Partial<GroupedCardSummaryItem> = {}): GroupedCardSummaryItem {
  return {
    id: 'notification-1',
    type: 'notification',
    source: 'system',
    title: 'Twitter cookies expired',
    text: 'Tweet-cache refresh hit 401 errors until AUTH_TOKEN and CT0 are refreshed.',
    reason: 'Authenticated endpoints are returning 401 errors.',
    metadata: {
      notificationId: 'tweet-cache-auth-expired',
      severity: 'warning',
    },
    ...overrides,
  };
}

describe('grouped card summary helpers', () => {
  test('builds a reusable suggestion summary with type, status, origin, and next-step framing', () => {
    const summary = buildGroupedCardSummary({
      groupType: 'suggestion',
      items: [
        createSuggestionItem({
          id: 'suggestion-chat-code-fix',
          title: 'Fix grouped suggestion card copy',
          source: 'codex',
          originSessionId: 'session-1',
          suggestionStatus: 'pending',
          text: 'Replace redundant grouped summary copy with approval-first details.',
          metadata: {
            suggestionType: 'code_fix',
            proposedValue: 'Grouped suggestion cards should describe the actual fixes inside instead of repeating footer metadata.',
          },
        }),
        createSuggestionItem({
          id: 'suggestion-reflection-config',
          suggestionStatus: 'running',
          title: 'Suggested config update: Analysis Style',
          text: 'Pending suggestion 2 is ready for Accept All verification in the suggestion group UI.',
          metadata: {
            suggestionType: 'code_fix',
            configField: 'Analysis Style',
            configFile: 'data/curation-prompt.md',
            proposedValue: 'Prefer shorter synthesis with explicit tradeoffs.',
            reflectionCycle: true,
          },
        }),
        createSuggestionItem({
          id: 'suggestion-resolved',
          suggestionStatus: 'merged',
          title: 'Resolved suggestion 3',
          text: 'Resolved suggestion 3 keeps the grouped card populated with bounded history for verification.',
          metadata: {
            suggestionType: 'code_fix',
            configField: 'Schedule',
            configFile: 'data/config.md',
            proposedValue: 'Slow curation slightly overnight and bias toward active hours.',
          },
        }),
      ],
    });

    assert.equal(summary.title, ['Awaiting', 'approval'].join(' '));
    assert.equal(summary.countLabel, '3 suggestions');
    assert.equal(summary.breakdown, '3 code fixes');
    assert.equal(summary.status, '1 pending, 1 in progress, and 1 resolved');
    assert.match(summary.origin, /chat follow-ups|reflection runs|config file|code updates/i);
    assert.match(summary.nextStep, /review|approve|open the group/i);
    assert.equal(summary.text, '');
  });

  test('builds a notification summary that surfaces severity, purpose, and handling guidance', () => {
    const summary = buildGroupedCardSummary({
      groupType: 'notification',
      items: [
        createNotificationItem(),
        createNotificationItem({
          id: 'notification-2',
          title: 'Cache refresh failed',
          text: 'Tweet-cache refresh failed because authenticated endpoints returned 401.',
          metadata: {
            notificationId: 'tweet-cache-auth-expired',
            severity: 'error',
          },
        }),
      ],
    });

    assert.equal(summary.title, '2 notifications');
    assert.equal(summary.countLabel, '2 notifications');
    assert.equal(summary.breakdown, '1 error and 1 warning');
    assert.match(summary.origin, /system alerts/i);
    assert.match(summary.origin, /authentication/i);
    assert.match(summary.nextStep, /Address the errors first/i);
    assert.match(summary.text, /2 notifications: 1 error and 1 warning\./);
  });

  test('serialization changes when summary-relevant status or origin fields change', () => {
    const baseline = serializeGroupedCardSummaryRequest({
      groupType: 'suggestion',
      items: [createSuggestionItem()],
    });
    const statusChanged = serializeGroupedCardSummaryRequest({
      groupType: 'suggestion',
      items: [createSuggestionItem({ suggestionStatus: 'running' })],
    });
    const originChanged = serializeGroupedCardSummaryRequest({
      groupType: 'suggestion',
      items: [createSuggestionItem({ originSessionId: 'session-2' })],
    });

    assert.notEqual(statusChanged, baseline);
    assert.notEqual(originChanged, baseline);
  });
});
