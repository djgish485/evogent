import { NextResponse } from 'next/server';
import {
  arrangeFeedDisplay,
  getSingletonShipmentThreadId,
  getQuarantinedFeedItemIds,
  isSingletonShipmentThreadId,
  LEGACY_CARRY_FORWARD_THREAD_ID,
  getSuggestionArrangePlacements,
  PRIMARY_FEED_SLATE_MAX_ITEMS,
  recordFeedArrangementRun,
  type FeedArrangeOrderingInput,
  type FeedArrangeThreadInput,
} from '@/lib/db/feed';
import { notifyFeedArranged } from '@/lib/curation-submit';
import {
  type FeedCarryForwardCandidate,
  type FeedCarryForwardCandidateList,
  type FeedCarryForwardReview,
  listFeedCarryForwardCandidates,
  recordCarryForwardPromotions,
} from '@/lib/feed-carry-forward';
import { withFeedMutationLock } from '@/lib/feed-mutation-lock';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${fieldName} must not be empty`);
  }
  return trimmed;
}

function readOptionalString(value: unknown, fieldName: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string when provided`);
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function readDisplayOrder(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${fieldName} must be a finite number`);
  }
  return Math.trunc(value);
}

function readBoolean(value: unknown, fieldName: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${fieldName} must be a boolean`);
  }
  return value;
}

function normalizeOrdering(rawOrdering: unknown): FeedArrangeOrderingInput[] {
  if (!Array.isArray(rawOrdering)) {
    throw new Error('ordering must be an array');
  }

  const seen = new Set<string>();
  return rawOrdering.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`ordering[${index}] must be an object`);
    }
    const feedItemId = readRequiredString(entry.feedItemId, `ordering[${index}].feedItemId`);
    if (seen.has(feedItemId)) {
      throw new Error(`ordering[${index}].feedItemId duplicates ${feedItemId}`);
    }
    seen.add(feedItemId);

    return {
      feedItemId,
      displayOrder: readDisplayOrder(entry.displayOrder, `ordering[${index}].displayOrder`),
      threadId: readOptionalString(entry.threadId, `ordering[${index}].threadId`),
      displaySubtitle: readOptionalString(entry.displaySubtitle, `ordering[${index}].displaySubtitle`),
    };
  });
}

function normalizeThreads(rawThreads: unknown): FeedArrangeThreadInput[] {
  if (!Array.isArray(rawThreads)) {
    throw new Error('threads must be an array');
  }

  const seen = new Set<string>();
  return rawThreads.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`threads[${index}] must be an object`);
    }
    const id = readRequiredString(entry.id, `threads[${index}].id`);
    if (seen.has(id)) {
      throw new Error(`threads[${index}].id duplicates ${id}`);
    }
    seen.add(id);

    return {
      id,
      title: readRequiredString(entry.title, `threads[${index}].title`),
      subtitle: readOptionalString(entry.subtitle, `threads[${index}].subtitle`),
      active: readBoolean(entry.active, `threads[${index}].active`),
    };
  });
}

/**
 * Every primary row is one stable shipment unit. A real display thread exists
 * only while at least two rows share its original id; all other rows receive a
 * deterministic per-item shipment id that renderers intentionally suppress.
 */
function assignShipmentThreadIds(
  ordering: FeedArrangeOrderingInput[],
): FeedArrangeOrderingInput[] {
  const originalThreadMemberCount = new Map<string, number>();
  for (const entry of ordering) {
    const threadId = entry.threadId?.trim() ?? '';
    if (
      !threadId
      || threadId === LEGACY_CARRY_FORWARD_THREAD_ID
      || isSingletonShipmentThreadId(threadId)
    ) {
      continue;
    }
    originalThreadMemberCount.set(
      threadId,
      (originalThreadMemberCount.get(threadId) ?? 0) + 1,
    );
  }

  return ordering.map((entry) => {
    const originalThreadId = entry.threadId?.trim() ?? '';
    const keepDisplayThread = originalThreadId !== ''
      && originalThreadId !== LEGACY_CARRY_FORWARD_THREAD_ID
      && !isSingletonShipmentThreadId(originalThreadId)
      && (originalThreadMemberCount.get(originalThreadId) ?? 0) >= 2;
    return {
      ...entry,
      threadId: keepDisplayThread
        ? originalThreadId
        : getSingletonShipmentThreadId(entry.feedItemId),
    };
  });
}

/**
 * Bound the primary slate without ever cutting through a curator-defined thread.
 *
 * A thread is one editorial shipment even if another lane temporarily interleaves
 * its rows. Oversized individual threads are rejected so an agent must make the
 * editorial decision about what belongs; mechanics must not silently amputate one.
 */
function capAtShipmentUnits(
  ordering: FeedArrangeOrderingInput[],
  maxItems: number,
): {
  ordering: FeedArrangeOrderingInput[];
  droppedShipmentUnitCount: number;
} {
  const unitSizes = new Map<string, number>();
  const unitOrder: string[] = [];
  const unitKey = (entry: FeedArrangeOrderingInput): string => (
    entry.threadId ? `thread:${entry.threadId}` : `item:${entry.feedItemId}`
  );

  for (const entry of ordering) {
    const key = unitKey(entry);
    if (!unitSizes.has(key)) {
      unitOrder.push(key);
      unitSizes.set(key, 0);
    }
    unitSizes.set(key, (unitSizes.get(key) ?? 0) + 1);
  }

  for (const key of unitOrder) {
    const size = unitSizes.get(key) ?? 0;
    if (key.startsWith('thread:') && size > maxItems) {
      throw new Error(
        `thread ${key.slice('thread:'.length)} has ${size} items and exceeds the ${maxItems}-item primary slate; revise the thread as an editorial unit`,
      );
    }
  }

  const keptUnits = new Set<string>();
  let keptCount = 0;
  let droppedShipmentUnitCount = 0;
  for (const key of unitOrder) {
    const size = unitSizes.get(key) ?? 0;
    if (keptCount + size <= maxItems) {
      keptUnits.add(key);
      keptCount += size;
    } else {
      droppedShipmentUnitCount += 1;
    }
  }

  return {
    ordering: ordering.filter((entry) => keptUnits.has(unitKey(entry))),
    droppedShipmentUnitCount,
  };
}

function readCurationCycleId(feedItemId: string): string | null {
  const match = feedItemId.match(/^(curate-\d{8}T\d{4}Z)-/);
  return match?.[1] ?? null;
}

function truncateDisplayText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

function buildCarryForwardDisplaySubtitle(candidate: FeedCarryForwardCandidate): string | null {
  // "Still unread" is a claim about time: an item that entered the feed within the last few
  // hours isn't lingering, it's just new — labeling it stale reads as a broken feed.
  const ageMs = candidate.createdAtMs ? Date.now() - candidate.createdAtMs : Number.POSITIVE_INFINITY;
  if (ageMs < 6 * 60 * 60 * 1000) {
    return null;
  }
  if (candidate.source === 'openclaw') {
    const agentBasis = candidate.title || candidate.reason || '';
    return agentBasis.trim()
      ? truncateDisplayText(`Still unread: ${agentBasis}`, 180)
      : 'Still unread from your agent.';
  }
  // threadRationale is the LANE's line — the banner already shows it; repeating it verbatim on
  // every member card reads as boilerplate (the distinct-bridge rule applies here too).
  const basis = candidate.reason || candidate.bridge || candidate.excerpt || '';
  if (!basis.trim()) {
    return 'Still unread from an earlier curation.';
  }
  return truncateDisplayText(`Still unread: ${basis}`, 180);
}

function normalizeCarryForwardThread(candidate: FeedCarryForwardCandidate): FeedArrangeThreadInput {
  const threadId = candidate.threadId?.trim();
  if (
    !threadId
    || threadId === LEGACY_CARRY_FORWARD_THREAD_ID
    || isSingletonShipmentThreadId(threadId)
  ) {
    throw new Error(`carry-forward ${candidate.id} does not have a real display thread`);
  }
  const title = candidate.threadTitle?.trim() || 'Still worth seeing';
  const subtitle = candidate.threadRationale?.trim() || 'Accepted earlier and still unread.';

  return {
    id: threadId,
    title,
    subtitle,
    active: true,
  };
}

type CarryForwardMergeAudit = {
  mode: 'none' | 'curator-included' | 'auto-injected' | 'deferred-by-slate-cap';
  candidatesFound: number;
  eligibleCount: number;
  reviewedCount: number;
  returnedCount: number;
  queryLimit: number;
  reviewLimit: number;
  includeAllUnviewed: boolean;
  includeDisplayed: boolean;
  candidateIds: string[];
  orderBasis: FeedCarryForwardReview['orderBasis'];
  promotedCandidates: Array<{
    id: string;
    reason: string | null;
    priorDisplayOrder: number | null;
  }>;
  promotedIds: string[];
  deferredBySlateCapIds: string[];
  structurallyExcludedIds: string[];
  alreadyIncludedIds: string[];
  skippedCurrentCycleIds: string[];
};

type CarryForwardMerge = {
  ordering: FeedArrangeOrderingInput[];
  threads: FeedArrangeThreadInput[];
  audit: CarryForwardMergeAudit;
};

/**
 * Preserve explicit agent shipment order, then append every omitted eligible
 * unseen shipment in stable prior-shipment/evidence order. Mechanics make no
 * freshness or value judgment here; the structural 50-item cap is applied by
 * the caller without splitting a shipment.
 */
function mergeCarryForwardPromotions(
  ordering: FeedArrangeOrderingInput[],
  threads: FeedArrangeThreadInput[],
): CarryForwardMerge {
  const orderedIds = new Set(ordering.map((item) => item.feedItemId));
  const currentCycleIds = new Set(
    ordering
      .map((item) => readCurationCycleId(item.feedItemId))
      .filter((cycleId): cycleId is string => Boolean(cycleId)),
  );
  const candidates = listFeedCarryForwardCandidates({
    includeAllUnviewed: true,
    includeDisplayed: true,
  }) as FeedCarryForwardCandidateList;
  const candidateReview: FeedCarryForwardReview = candidates.review;
  const skippedCurrentCycleIds: string[] = [];
  const alreadyIncludedIds: string[] = [];
  const promotable: FeedCarryForwardCandidate[] = [];

  for (const candidate of candidates) {
    if (orderedIds.has(candidate.id)) {
      alreadyIncludedIds.push(candidate.id);
      continue;
    }

    const cycleId = readCurationCycleId(candidate.id);
    if (cycleId && currentCycleIds.has(cycleId)) {
      skippedCurrentCycleIds.push(candidate.id);
      continue;
    }
    promotable.push(candidate);
  }

  const explicitOrdering = ordering
    .map((item, index) => ({ item, index }))
    .sort((left, right) => (
      left.item.displayOrder - right.item.displayOrder
      || left.index - right.index
    ))
    .map(({ item }) => item);

  type ShipmentUnit = {
    key: string;
    realThreadId: string | null;
    entries: FeedArrangeOrderingInput[];
    carryForwardCandidates: FeedCarryForwardCandidate[];
  };
  const units: ShipmentUnit[] = [];
  const unitByKey = new Map<string, ShipmentUnit>();
  const readRealThreadId = (threadId: string | null | undefined): string | null => {
    const normalized = threadId?.trim() ?? '';
    return normalized
      && normalized !== LEGACY_CARRY_FORWARD_THREAD_ID
      && !isSingletonShipmentThreadId(normalized)
      ? normalized
      : null;
  };
  const appendToUnit = (
    entry: FeedArrangeOrderingInput,
    candidate: FeedCarryForwardCandidate | null,
  ) => {
    const realThreadId = readRealThreadId(entry.threadId);
    const key = realThreadId ? `thread:${realThreadId}` : `solo:${entry.feedItemId}`;
    let unit = unitByKey.get(key);
    if (!unit) {
      unit = {
        key,
        realThreadId,
        entries: [],
        carryForwardCandidates: [],
      };
      unitByKey.set(key, unit);
      units.push(unit);
    }
    unit.entries.push(entry);
    if (candidate) {
      unit.carryForwardCandidates.push(candidate);
    }
  };

  for (const entry of explicitOrdering) {
    appendToUnit(entry, null);
  }
  for (const candidate of promotable) {
    appendToUnit({
      feedItemId: candidate.id,
      displayOrder: 0,
      threadId: candidate.threadId,
      displaySubtitle: buildCarryForwardDisplaySubtitle(candidate),
    }, candidate);
  }

  // A real thread remains one contiguous structural shipment. Its first
  // explicit occurrence fixes unit order; omitted eligible members join that
  // unit without re-ranking any explicit shipment.
  const mergedOrdering = units
    .flatMap((unit) => unit.entries)
    .map((item, index) => ({
      ...item,
      displayOrder: index + 1,
    }));

  const bannerThreads: FeedArrangeThreadInput[] = [];
  for (const unit of units) {
    if (
      unit.realThreadId
      && unit.entries.length >= 2
      && unit.carryForwardCandidates.length > 0
    ) {
      bannerThreads.push(normalizeCarryForwardThread(unit.carryForwardCandidates[0]));
    }
  }

  // Shipment-singleton ids deliberately have no feed_threads row: they bound cap
  // mechanics and persist across passes, but cannot surface as a banner or sidebar lane.
  // Dropping the retired shared lane also self-heals older arrangements.
  const mergedThreads = threads.filter((thread) => (
    thread.id !== LEGACY_CARRY_FORWARD_THREAD_ID
    && !isSingletonShipmentThreadId(thread.id)
  ));
  const threadIds = new Set(mergedThreads.map((thread) => thread.id));
  for (const thread of bannerThreads) {
    if (threadIds.has(thread.id)) continue;
    threadIds.add(thread.id);
    mergedThreads.push(thread);
  }

  return {
    ordering: mergedOrdering,
    threads: mergedThreads,
    audit: {
      mode: promotable.length > 0
        ? 'auto-injected'
        : alreadyIncludedIds.length > 0
          ? 'curator-included'
          : 'none',
      candidatesFound: candidates.length,
      eligibleCount: candidateReview.eligibleCount,
      reviewedCount: candidateReview.reviewedCount,
      returnedCount: candidateReview.returnedCount,
      queryLimit: candidateReview.queryLimit,
      reviewLimit: candidateReview.reviewLimit,
      includeAllUnviewed: candidateReview.includeAllUnviewed,
      includeDisplayed: candidateReview.includeDisplayed,
      candidateIds: candidateReview.candidateIds,
      orderBasis: candidateReview.orderBasis,
      promotedCandidates: promotable.map((candidate) => ({
        id: candidate.id,
        reason: candidate.reason || candidate.bridge || candidate.threadRationale,
        priorDisplayOrder: candidate.displayOrder,
      })),
      promotedIds: promotable.map((candidate) => candidate.id),
      deferredBySlateCapIds: [],
      structurallyExcludedIds: [],
      alreadyIncludedIds,
      skippedCurrentCycleIds,
    },
  };
}

function finalizeCarryForwardAudit(
  audit: CarryForwardMergeAudit,
  shippedOrdering: FeedArrangeOrderingInput[],
  structurallyExcludedIds: Set<string>,
): CarryForwardMergeAudit {
  const shippedIds = new Set(shippedOrdering.map((entry) => entry.feedItemId));
  const promotedIds = audit.promotedIds.filter((id) => shippedIds.has(id));
  const excludedIds = audit.promotedIds.filter((id) => structurallyExcludedIds.has(id));
  const deferredBySlateCapIds = audit.promotedIds.filter(
    (id) => !shippedIds.has(id) && !structurallyExcludedIds.has(id),
  );
  return {
    ...audit,
    mode: promotedIds.length > 0
      ? 'auto-injected'
      : deferredBySlateCapIds.length > 0
        ? 'deferred-by-slate-cap'
        : audit.alreadyIncludedIds.length > 0
          ? 'curator-included'
          : 'none',
    promotedCandidates: audit.promotedCandidates.filter(
      (candidate) => shippedIds.has(candidate.id),
    ),
    promotedIds,
    deferredBySlateCapIds,
    structurallyExcludedIds: excludedIds,
  };
}

/**
 * Suggestions live INLINE in the main feed: important ones above all content,
 * the rest just below the first content block, and the code-fix development
 * backlog at the end. Deterministic here so every arrange path
 * (curator run or rearrange backstop) produces the same placement whether or not the curator
 * included suggestion rows in its ordering.
 */
const normalSuggestionInsertAfter = 3;
// Hard cap on suggestions shown ABOVE any content. Without it, a batch of high-importance
// life-admin cards (the sweep can mark several "high") buries the feed under a wall of cards
// before any content appears. Keep the 2 most important at the very top; the rest drop to the
// inline lane below the first content.
const maxSuggestionsAboveContent = 2;

function placePendingSuggestions(
  ordering: FeedArrangeOrderingInput[],
  placements = getSuggestionArrangePlacements(),
): {
  ordering: FeedArrangeOrderingInput[];
  audit: { topCount: number; inlineCount: number; backlogCount: number };
} {
  const { pending, allSuggestionIds } = placements;
  const content = ordering.filter((entry) => !allSuggestionIds.has(entry.feedItemId));
  const toEntry = (placement: { id: string }): FeedArrangeOrderingInput => ({
    feedItemId: placement.id,
    displayOrder: 0,
    threadId: null,
    displaySubtitle: null,
  });
  // Silence is not an editorial decision. A pending suggestion keeps its explicit
  // importance/placement until the user or agent resolves it, or its own expiresAtMs says
  // the underlying action is no longer available.
  const isExplicitlyExpired = (entry: { expiresAtMs: number | null }) => (
    entry.expiresAtMs !== null && Date.now() > entry.expiresAtMs
  );
  const nonCodeFix = pending.filter((entry) => entry.suggestionType !== 'code_fix');
  const explicitlyExpired = nonCodeFix.filter(isExplicitlyExpired);
  const high = nonCodeFix.filter((entry) => entry.importance === 'high' && !isExplicitlyExpired(entry));
  const normal = nonCodeFix.filter((entry) => entry.importance !== 'high' && !isExplicitlyExpired(entry));
  const codeFix = pending.filter((entry) => entry.suggestionType === 'code_fix');
  // At most maxSuggestionsAboveContent (from the high-importance set) lead the feed; the rest —
  // high overflow first, then normal — interleave in pairs between content blocks. A single
  // inline insertion point turns a busy life-admin day into a 9-card wall that reads the same
  // as the old pinned block; pairs every few content items keep the feed scannable.
  const top = high.slice(0, maxSuggestionsAboveContent);
  const inline = [...high.slice(maxSuggestionsAboveContent), ...normal];
  const inlinePairs: FeedArrangeOrderingInput[][] = [];
  for (let i = 0; i < inline.length; i += 2) {
    inlinePairs.push(inline.slice(i, i + 2).map(toEntry));
  }
  const merged: FeedArrangeOrderingInput[] = [...top.map(toEntry)];
  let contentIndex = 0;
  let pairIndex = 0;
  while (contentIndex < content.length || pairIndex < inlinePairs.length) {
    merged.push(...content.slice(contentIndex, contentIndex + normalSuggestionInsertAfter));
    contentIndex += normalSuggestionInsertAfter;
    if (pairIndex < inlinePairs.length) {
      merged.push(...inlinePairs[pairIndex]);
      pairIndex += 1;
    }
  }
  // Explicitly expired actions and the developer repair queue remain accessible in their
  // dedicated suggestion lanes, but they do not consume the primary information slate.
  const ordered = merged.map((entry, index) => ({ ...entry, displayOrder: index + 1 }));
  return {
    ordering: ordered,
    audit: { topCount: top.length, inlineCount: inline.length, backlogCount: explicitlyExpired.length + codeFix.length },
  };
}

async function postUnlocked(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON payload' }, { status: 400 });
  }

  try {
    if (!isRecord(body)) {
      throw new Error('Request body must be a JSON object');
    }

    const normalizedOrdering = normalizeOrdering(body.ordering);
    const quarantinedIds = getQuarantinedFeedItemIds(
      normalizedOrdering.map((entry) => entry.feedItemId),
    );
    const unquarantinedOrdering = normalizedOrdering.filter(
      (entry) => !quarantinedIds.has(entry.feedItemId),
    );
    const threads = normalizeThreads(body.threads).filter((thread) => (
      thread.id !== LEGACY_CARRY_FORWARD_THREAD_ID
      && !isSingletonShipmentThreadId(thread.id)
    ));
    const curatorCarryForwardAudit = isRecord(body.carryForwardAudit)
      ? body.carryForwardAudit
      : isRecord(body.cycleSummary) && isRecord(body.cycleSummary.carryForwardAudit)
        ? body.cycleSummary.carryForwardAudit
        : null;
    const carryForwardMerge = mergeCarryForwardPromotions(
      unquarantinedOrdering,
      threads,
    );
    const suggestionPlacements = getSuggestionArrangePlacements();
    const contentOrdering = carryForwardMerge.ordering.filter(
      (entry) => !suggestionPlacements.allSuggestionIds.has(entry.feedItemId),
    );
    const structurallyExcludedIds = getQuarantinedFeedItemIds(
      contentOrdering.map((entry) => entry.feedItemId),
    );
    for (const id of structurallyExcludedIds) quarantinedIds.add(id);
    const uncappedContentOrdering = assignShipmentThreadIds(
      contentOrdering.filter(
        (entry) => !structurallyExcludedIds.has(entry.feedItemId),
      ),
    );
    const capped = capAtShipmentUnits(
      uncappedContentOrdering,
      PRIMARY_FEED_SLATE_MAX_ITEMS,
    );
    const cappedContentOrdering = capped.ordering
      .map((entry, index) => ({ ...entry, displayOrder: index + 1 }));
    const carryForwardAudit = finalizeCarryForwardAudit(
      carryForwardMerge.audit,
      cappedContentOrdering,
      structurallyExcludedIds,
    );
    const suggestionPlacement = placePendingSuggestions(
      cappedContentOrdering,
      suggestionPlacements,
    );
    const suggestionQuarantinedIds = getQuarantinedFeedItemIds(
      suggestionPlacement.ordering.map((entry) => entry.feedItemId),
    );
    for (const id of suggestionQuarantinedIds) quarantinedIds.add(id);
    const finalOrdering = assignShipmentThreadIds(
      suggestionPlacement.ordering.filter(
        (entry) => !quarantinedIds.has(entry.feedItemId),
      ),
    ).map((entry, index) => ({ ...entry, displayOrder: index + 1 }));
    const referencedThreadIds = new Set(
      finalOrdering
        .map((entry) => entry.threadId)
        .filter((threadId): threadId is string => Boolean(threadId)),
    );
    const finalThreads = carryForwardMerge.threads.filter(
      (thread) => !thread.active || referencedThreadIds.has(thread.id),
    );
    const slateCap = {
      maxItems: PRIMARY_FEED_SLATE_MAX_ITEMS,
      beforeCount: uncappedContentOrdering.length,
      afterCount: cappedContentOrdering.length,
      droppedCount: uncappedContentOrdering.length - cappedContentOrdering.length,
      droppedShipmentUnitCount: capped.droppedShipmentUnitCount,
      quarantinedCount: structurallyExcludedIds.size,
      nonPrimarySuggestionCount: finalOrdering.length - cappedContentOrdering.length,
    };
    const activeThreadIds = new Set(finalThreads.filter((thread) => thread.active).map((thread) => thread.id));

    for (const [index, item] of finalOrdering.entries()) {
      if (
        item.threadId
        && !activeThreadIds.has(item.threadId)
        && !isSingletonShipmentThreadId(item.threadId)
      ) {
        throw new Error(`ordering[${index}].threadId must reference an active listed thread`);
      }
    }

    const result = arrangeFeedDisplay({ ordering: finalOrdering, threads: finalThreads });
    if (carryForwardAudit.promotedIds.length > 0) {
      recordCarryForwardPromotions(carryForwardAudit.promotedIds);
    }
    const arrangementRunId = recordFeedArrangementRun({
      source: 'curator',
      ordering: finalOrdering,
      threads: finalThreads,
      updatedItemIds: result.updatedItemIds,
      carryForwardAudit,
      curatorCarryForwardAudit,
    });
    const snapshot = {
      arrangementRunId,
      ordering: finalOrdering,
      activeThreads: result.activeThreads,
      updatedItemIds: result.updatedItemIds,
      orderingCount: result.orderingCount,
      threadCount: result.threadCount,
      carryForwardAudit,
      curatorCarryForwardAudit,
      suggestionPlacement: suggestionPlacement.audit,
      slateCap,
    };

    await notifyFeedArranged(snapshot);
    return NextResponse.json({
      ok: true,
      completedPendingAutomatedCuration: false,
      ...snapshot,
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to arrange feed',
    }, { status: 400 });
  }
}

export async function POST(request: Request) {
  return withFeedMutationLock(() => postUnlocked(request));
}
