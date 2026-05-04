import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  isFailedBatchEnrichmentTask,
  markFailedBatchEnrichmentItems,
} from '../lib/batch-enrichment-finalizer.js';

function buildTask(overrides = {}) {
  return {
    id: 'curation-submit-enrichment-batch-post-1',
    state: 'failed',
    priority: 'post_enrichment',
    completedAt: '2026-04-27T04:52:19.604Z',
    error: 'Claude usage limit reached',
    metadata: {
      enrichmentMode: 'batch',
      trigger: 'automatic_post_enrichment_batch',
      postIds: ['post-1', 'post-2', 'post-3'],
    },
    ...overrides,
  };
}

function buildItem(id, batch = {}) {
  return {
    id,
    metadata: {
      batchEnrichment: {
        requestId: 'curation-submit-enrichment-batch-post-1',
        status: 'queued',
        queuedAt: '2026-04-27T04:52:16.682Z',
        retryEligible: true,
        ...batch,
      },
    },
  };
}

describe('batch enrichment failure finalizer', () => {
  test('recognizes failed batch enrichment tasks independent of trigger spelling', () => {
    assert.equal(isFailedBatchEnrichmentTask(buildTask()), true);
    assert.equal(isFailedBatchEnrichmentTask(buildTask({
      metadata: {
        enrichmentMode: 'batch',
        trigger: 'curation_submit_batch',
        postIds: ['post-1'],
      },
    })), true);
    assert.equal(isFailedBatchEnrichmentTask(buildTask({ state: 'completed' })), false);
  });

  test('failed-before-agent-patch marks unfinished batch items failed', async () => {
    const patches = [];
    const items = new Map([
      ['post-1', buildItem('post-1')],
      ['post-2', {
        ...buildItem('post-2'),
        children: [{
          id: 'reply-1',
          relationship: 'reply',
          text: 'useful reply',
        }],
      }],
      ['post-3', buildItem('post-3', {
        status: 'completed',
        replyAudit: {
          batchRequestId: 'curation-submit-enrichment-batch-post-1',
          inspectedReplySurface: true,
          savedReplyCount: 0,
          savedReplyIds: [],
          noMeaningfulRepliesReason: 'No durable replies.',
          inspectedAt: '2026-04-27T04:53:00.000Z',
        },
      })],
    ]);

    const fetchFn = async (url, init = {}) => {
      const postId = decodeURIComponent(String(url).split('/').pop() ?? '');
      if (init.method === 'PATCH') {
        patches.push({ postId, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ item: items.get(postId) }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const result = await markFailedBatchEnrichmentItems(buildTask(), {
      internalBaseUrl: 'http://127.0.0.1:3112',
      fetchFn,
      logger: { warn: () => undefined },
    });

    assert.deepEqual(result, { checked: 3, patched: 1 });
    assert.equal(patches.length, 1);
    assert.equal(patches[0].postId, 'post-1');
    assert.deepEqual(patches[0].body.metadata.batchEnrichment, {
      requestId: 'curation-submit-enrichment-batch-post-1',
      status: 'failed',
      failedAt: '2026-04-27T04:52:19.604Z',
      retryEligible: true,
      failureReason: 'Claude usage limit reached',
    });
  });

  test('uses top-level feed detail reply children as batch completion evidence', async () => {
    const patches = [];
    const replyChild = {
      id: 'reply-1',
      type: 'tweet',
      relationship: 'reply',
      text: 'useful reply',
    };
    const relatedChild = {
      id: 'related-1',
      type: 'article',
      relationship: 'related',
      text: 'related context',
    };
    const detailPayloads = new Map([
      ['post-with-replies', {
        item: buildItem('post-with-replies'),
        children: [replyChild],
        childrenByRelationship: {
          reply: [replyChild],
          related: [],
        },
      }],
      ['post-related-only', {
        item: buildItem('post-related-only'),
        children: [relatedChild],
        childrenByRelationship: {
          reply: [],
          related: [relatedChild],
        },
      }],
    ]);

    const fetchFn = async (url, init = {}) => {
      const postId = decodeURIComponent(String(url).split('/').pop() ?? '');
      if (init.method === 'PATCH') {
        patches.push({ postId, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify(detailPayloads.get(postId)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const result = await markFailedBatchEnrichmentItems(buildTask({
      metadata: {
        enrichmentMode: 'batch',
        postIds: ['post-with-replies', 'post-related-only'],
      },
    }), {
      internalBaseUrl: 'http://127.0.0.1:3112',
      fetchFn,
      logger: { warn: () => undefined },
    });

    assert.deepEqual(result, { checked: 2, patched: 1 });
    assert.equal(patches.length, 1);
    assert.equal(patches[0].postId, 'post-related-only');
    assert.equal(patches[0].body.metadata.batchEnrichment.status, 'failed');
  });
});
