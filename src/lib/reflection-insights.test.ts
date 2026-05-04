import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  categorizeRejectionReason,
  getRejectionScorecard,
  normalizeReflectionHours,
} from './reflection-insights';

describe('reflection insights helpers', () => {
  test('normalizeReflectionHours defaults invalid input and clamps large values', () => {
    assert.strictEqual(normalizeReflectionHours(null), 168);
    assert.strictEqual(normalizeReflectionHours('banana'), 168);
    assert.strictEqual(normalizeReflectionHours('0'), 168);
    assert.strictEqual(normalizeReflectionHours('999999'), 8760);
  });
});

describe('getRejectionScorecard', () => {
  let tempDir = '';
  let filePath = '';

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evogent-rejection-scorecard-'));
    filePath = path.join(tempDir, 'curation-candidates.jsonl');
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('returns empty scorecard when candidate log is missing', async () => {
    const result = await getRejectionScorecard(24, {
      filePath,
      now: Date.parse('2026-03-09T12:00:00.000Z'),
    });

    assert.deepStrictEqual(result, {
      cycleCount: 0,
      totalRejected: 0,
      topRejectedAuthors: [],
      rejectionReasonCategories: {},
      sourceQualityMisses: 0,
      almostRelevant: [],
      hoursQueried: 24,
    });
  });

  test('parses recent candidate lines, skips malformed records, and groups rejection categories', async () => {
    const lines = [
      'not-json',
      JSON.stringify({
        type: 'cycle_summary',
        cycleId: 'cycle-1',
        considered: 5,
        selected: 1,
        rejected: 4,
        topRejectionReasons: ['duplicate'],
        timestamp: '2026-03-09T11:30:00.000Z',
      }),
      JSON.stringify({
        cycleId: 'cycle-1',
        sourceId: 'candidate-1',
        authorUsername: '@sentdefender',
        text: 'Duplicate theme post',
        reason: 'Looked relevant on first pass',
        rejectionReason: 'Already covered in yesterday\'s curation review.',
        timestamp: '2026-03-09T11:31:00.000Z',
      }),
      JSON.stringify({
        cycleId: 'cycle-1',
        sourceId: 'candidate-2',
        authorUsername: '@sentdefender',
        text: 'Thin post',
        reason: 'Topic fit, but weak substance',
        rejectionReason: 'Low info one-liner with no supporting detail.',
        timestamp: '2026-03-09T11:32:00.000Z',
      }),
      JSON.stringify({
        cycleId: 'cycle-2',
        sourceId: 'candidate-3',
        authorUsername: '@mechanismwatch',
        text: 'Breaking update',
        reason: 'Fresh event coverage',
        rejectionReason: 'Event reporting with no analysis or mechanism.',
        timestamp: '2026-03-09T11:33:00.000Z',
      }),
      JSON.stringify({
        cycleId: 'cycle-2',
        sourceId: 'candidate-4',
        authorUsername: '@offtopic',
        text: 'Tangential item',
        reason: 'Weak tie to interests',
        rejectionReason: 'Off-topic for the current curation brief.',
        timestamp: '2026-03-09T11:34:00.000Z',
      }),
      JSON.stringify({
        cycleId: 'cycle-2',
        sourceId: 'candidate-5',
        authorUsername: '@mystery',
        text: 'Odd fit',
        reason: 'Possibly interesting edge case',
        rejectionReason: 'Needs better evidence before inclusion.',
        timestamp: '2026-03-09T11:35:00.000Z',
      }),
      JSON.stringify({
        cycleId: 'cycle-2',
        sourceId: 'candidate-6',
        authorUsername: '@cachevictim',
        text: 'This cached timeline text visibly ends mid',
        reason: 'Cache row marked incomplete after status-page recovery failed.',
        rejectionReason: 'source-incomplete-text: cached timeline text visibly truncated',
        timestamp: '2026-03-09T11:36:00.000Z',
        metadata: {
          rejectionScope: 'source_quality',
          sourceQualityIssue: 'twitter_text_incomplete',
        },
      }),
      JSON.stringify({
        cycleId: 'cycle-old',
        sourceId: 'candidate-old',
        authorUsername: '@old',
        text: 'Old item',
        reason: 'Expired',
        rejectionReason: 'already covered',
        timestamp: '2026-03-07T11:35:00.000Z',
      }),
    ];

    await fs.promises.writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');

    const result = await getRejectionScorecard(24, {
      filePath,
      now: Date.parse('2026-03-09T12:00:00.000Z'),
    });

    assert.deepStrictEqual(result, {
      cycleCount: 1,
      totalRejected: 6,
      topRejectedAuthors: [
        { username: '@sentdefender', count: 2 },
        { username: '@mechanismwatch', count: 1 },
        { username: '@mystery', count: 1 },
        { username: '@offtopic', count: 1 },
      ],
      rejectionReasonCategories: {
        'already covered/duplicate': 1,
        'evidence gap/speculative': 1,
        'event-only reporting': 1,
        'low-signal/quality bar': 1,
        'source text incomplete/recovery': 1,
        'topic fit/boundary': 1,
      },
      sourceQualityMisses: 1,
      almostRelevant: [],
      hoursQueried: 24,
    });
  });

  test('returns long-form rejection reasons as almost relevant items', async () => {
    await fs.promises.writeFile(filePath, `${JSON.stringify({
      type: 'cycle_summary',
      cycleId: 'cycle-3',
      timestamp: '2026-03-09T11:00:00.000Z',
    })}\n${JSON.stringify({
      cycleId: 'cycle-3',
      sourceId: 'candidate-9',
      authorUsername: '@closecall',
      text: 'Near miss candidate',
      reason: 'The topic overlaps with the user\'s recent questions.',
      rejectionReason: 'Interesting mechanism thread, but it is slightly outside the current topic boundaries even though the user keeps asking adjacent questions.',
      timestamp: '2026-03-09T11:01:00.000Z',
    })}\n`, 'utf8');

    const result = await getRejectionScorecard(24, {
      filePath,
      now: Date.parse('2026-03-09T12:00:00.000Z'),
    });

    assert.strictEqual(result.cycleCount, 1);
    assert.strictEqual(result.totalRejected, 1);
    assert.deepStrictEqual(result.almostRelevant, [
      {
        sourceId: 'candidate-9',
        authorUsername: '@closecall',
        text: 'Near miss candidate',
        reason: 'The topic overlaps with the user\'s recent questions.',
        rejectionReason: 'Interesting mechanism thread, but it is slightly outside the current topic boundaries even though the user keeps asking adjacent questions.',
      },
    ]);
  });

  test('categorizeRejectionReason uses broader curation-quality buckets', () => {
    assert.strictEqual(categorizeRejectionReason('low engagement and weak substance for the quality bar'), 'low-signal/quality bar');
    assert.strictEqual(categorizeRejectionReason('Interesting but outside the current topic boundaries'), 'topic fit/boundary');
    assert.strictEqual(categorizeRejectionReason('Needs better evidence before inclusion'), 'evidence gap/speculative');
    assert.strictEqual(categorizeRejectionReason('Older version and stale timing for this cycle'), 'novelty/timing');
    assert.strictEqual(categorizeRejectionReason('Clickbait aggregator post'), 'source quality/noise');
    assert.strictEqual(categorizeRejectionReason('Cached timeline text visibly truncated before the claim ended'), 'source text incomplete/recovery');
  });

  test('categorizeRejectionReason uses consideration context when rejection text is vague', () => {
    assert.strictEqual(
      categorizeRejectionReason(
        'Interesting but not quite there for this cycle.',
        'Considered for novelty, but it is just a shallow reactive commentary thread.',
      ),
      'low-signal/quality bar',
    );
  });
});
