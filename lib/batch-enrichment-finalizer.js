function normalizeString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function hasRelationshipReplyChild(children) {
  return Array.isArray(children) && children.some((child) => child && child.relationship === 'reply');
}

function hasGroupedReplyChild(childrenByRelationship) {
  return Array.isArray(childrenByRelationship?.reply)
    && childrenByRelationship.reply.some((child) => child);
}

function hasReplyChildren(detailPayload) {
  const item = detailPayload?.item && typeof detailPayload.item === 'object' ? detailPayload.item : detailPayload;
  return hasRelationshipReplyChild(detailPayload?.children)
    || hasGroupedReplyChild(detailPayload?.childrenByRelationship)
    || hasRelationshipReplyChild(item?.children)
    || hasGroupedReplyChild(item?.childrenByRelationship);
}

function hasTerminalBatchReplyAudit(item, batchRequestId) {
  const batch = item?.metadata?.batchEnrichment;
  if (!batch || batch.requestId !== batchRequestId) return false;

  const audit = batch.replyAudit;
  if (!audit || typeof audit !== 'object') return false;
  if (typeof audit.savedReplyCount === 'number' && audit.savedReplyCount > 0) return true;
  if (Array.isArray(audit.savedReplyIds) && audit.savedReplyIds.length > 0) return true;
  if (typeof audit.noMeaningfulRepliesReason === 'string' && audit.noMeaningfulRepliesReason.trim()) return true;

  return Boolean((audit.inspectedReplySurface === true || audit.inspectedCommentSurface === true)
    && typeof audit.inspectedAt === 'string'
    && audit.inspectedAt.trim());
}

function isFailedBatchEnrichmentTask(task) {
  if (!task || task.state !== 'failed') return false;
  const metadata = task.metadata && typeof task.metadata === 'object' ? task.metadata : null;
  return metadata?.enrichmentMode === 'batch' && Array.isArray(metadata.postIds) && metadata.postIds.length > 0;
}

function buildBatchFailurePatch(task) {
  return {
    metadata: {
      batchEnrichment: {
        requestId: task.id,
        status: 'failed',
        failedAt: normalizeString(task?.completedAt) || new Date().toISOString(),
        retryEligible: true,
        failureReason: normalizeString(task?.error)
          || 'Automatic batch enrichment failed before this item wrote a terminal reply/comment audit receipt.',
      },
    },
  };
}

async function markFailedBatchEnrichmentItems(task, { internalBaseUrl, fetchFn = globalThis.fetch, logger = console } = {}) {
  if (!isFailedBatchEnrichmentTask(task)) {
    return { checked: 0, patched: 0 };
  }
  if (typeof internalBaseUrl !== 'string' || !internalBaseUrl.trim()) throw new Error('internalBaseUrl is required');
  if (typeof fetchFn !== 'function') throw new Error('fetch is not available');

  const metadata = task.metadata;
  const postIds = Array.from(new Set(metadata.postIds
    .map((postId) => normalizeString(postId))
    .filter(Boolean)));
  let checked = 0;
  let patched = 0;

  await Promise.all(postIds.map(async (postId) => {
    try {
      const getResponse = await fetchFn(`${internalBaseUrl}/api/feed/${encodeURIComponent(postId)}`, {
        method: 'GET',
        cache: 'no-store',
      });
      if (!getResponse.ok) return;

      checked += 1;
      const payload = await getResponse.json();
      const item = payload?.item && typeof payload.item === 'object' ? payload.item : null;
      const batch = item?.metadata?.batchEnrichment;
      if (!batch || batch.requestId !== task.id) return;
      if (hasReplyChildren(payload) || hasTerminalBatchReplyAudit(item, task.id)) return;

      const patchResponse = await fetchFn(`${internalBaseUrl}/api/feed/${encodeURIComponent(postId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBatchFailurePatch(task)),
      });
      if (patchResponse.ok) {
        patched += 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn?.(`[orchestrator] failed to mark batch enrichment item ${postId} failed: ${message}`);
    }
  }));

  return { checked, patched };
}

module.exports = { isFailedBatchEnrichmentTask, markFailedBatchEnrichmentItems };
