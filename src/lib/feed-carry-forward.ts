import { getDb } from '@/lib/db/client';

export const defaultCarryForwardWindowHours = 24 * 30;
export const defaultCarryForwardLimit = 100;
export const defaultCarryForwardReviewLimit = 50000;
export const maxCarryForwardLimit = 1000;
export const maxCarryForwardReviewLimit = 50000;
export const maxCarryForwardWindowHours = 24 * 365 * 10;

const carryForwardTypes = ['tweet', 'article', 'analysis', 'youtube', 'hackernews'] as const;

export const interestDurabilities = ['evergreen', 'dated', 'news'] as const;
export type InterestDurability = (typeof interestDurabilities)[number];

export function normalizeInterestDurability(value: unknown): InterestDurability | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return (interestDurabilities as readonly string[]).includes(normalized)
    ? normalized as InterestDurability
    : null;
}

const interactionActions = [
  'view',
  'expand',
  'like',
  'thumbsup',
  'dislike',
  'thumbsdown',
  'thread_feedback',
  'suggestion_dismissed',
  'suggestion_accepted',
] as const;

type CarryForwardRow = {
  id: string;
  type: string;
  source: string | null;
  source_id: string | null;
  title: string | null;
  text: string | null;
  excerpt: string | null;
  reason: string | null;
  url: string | null;
  created_at: string;
  created_at_ms: number | null;
  published_at: string;
  display_order: number | null;
  interest_score: number | null;
  interest_durability: string | null;
  thread_id: string | null;
  author_username: string | null;
  thread_title: string | null;
  thread_rationale: string | null;
  bridge: string | null;
};

export type FeedCarryForwardCandidate = {
  id: string;
  type: string;
  source: string | null;
  sourceId: string | null;
  authorUsername: string | null;
  title: string | null;
  text: string | null;
  excerpt: string | null;
  reason: string | null;
  url: string | null;
  createdAt: string;
  createdAtMs: number | null;
  publishedAt: string;
  displayOrder: number | null;
  interestScore: number | null;
  interestDurability: InterestDurability | null;
  threadId: string | null;
  threadTitle: string | null;
  threadRationale: string | null;
  bridge: string | null;
  carryForward: true;
};

export type FeedCarryForwardReview = {
  includeAllUnviewed: boolean;
  includeDisplayed: boolean;
  cutoffMs: number | null;
  eligibleCount: number;
  reviewedCount: number;
  returnedCount: number;
  queryLimit: number;
  reviewLimit: number;
  candidateIds: string[];
  orderBasis: 'prior_agent_shipment_then_evidence_sequence';
  generatedAtMs: number;
};

export type FeedCarryForwardCandidateList = FeedCarryForwardCandidate[] & {
  review: FeedCarryForwardReview;
};

export type FeedCarryForwardQuery = {
  windowHours?: number;
  limit?: number;
  nowMs?: number;
  excludeIds?: Iterable<string>;
  includeDisplayed?: boolean;
  includeAllUnviewed?: boolean;
  reviewLimit?: number;
};

export function normalizeCarryForwardBoundedInt(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(parsed)));
}

function normalizeExcludeIds(excludeIds: Iterable<string> | undefined): string[] {
  if (!excludeIds) {
    return [];
  }

  const normalized = new Set<string>();
  for (const id of excludeIds) {
    const trimmed = typeof id === 'string' ? id.trim() : '';
    if (trimmed) {
      normalized.add(trimmed);
    }
  }
  return [...normalized];
}

function normalizeCarryForwardRow(row: CarryForwardRow): FeedCarryForwardCandidate {
  const interestScore = typeof row.interest_score === 'number' && Number.isFinite(row.interest_score)
    ? Math.max(0, Math.min(1, row.interest_score))
    : null;
  return {
    id: row.id,
    type: row.type,
    source: row.source,
    authorUsername: row.author_username ?? null,
    sourceId: row.source_id,
    title: row.title,
    text: row.text,
    excerpt: row.excerpt,
    reason: row.reason,
    url: row.url,
    createdAt: row.created_at,
    createdAtMs: row.created_at_ms,
    publishedAt: row.published_at,
    displayOrder: row.display_order,
    interestScore,
    interestDurability: normalizeInterestDurability(row.interest_durability),
    threadId: row.thread_id,
    threadTitle: row.thread_title,
    threadRationale: row.thread_rationale,
    bridge: row.bridge,
    carryForward: true,
  };
}

export function listFeedCarryForwardCandidates(input: FeedCarryForwardQuery = {}): FeedCarryForwardCandidateList {
  const windowHours = normalizeCarryForwardBoundedInt(
    input.windowHours,
    defaultCarryForwardWindowHours,
    maxCarryForwardWindowHours,
  );
  const limit = normalizeCarryForwardBoundedInt(input.limit, defaultCarryForwardLimit, maxCarryForwardLimit);
  const requestedReviewLimit = normalizeCarryForwardBoundedInt(
    input.reviewLimit,
    defaultCarryForwardReviewLimit,
    maxCarryForwardReviewLimit,
  );
  const nowMs = Number.isFinite(input.nowMs) ? Number(input.nowMs) : Date.now();
  const includeAllUnviewed = input.includeAllUnviewed === true;
  const cutoffMs = includeAllUnviewed ? null : nowMs - windowHours * 60 * 60 * 1000;
  const interactionPlaceholders = interactionActions.map(() => '?').join(', ');
  const excludedIds = normalizeExcludeIds(input.excludeIds);
  const excludedIdClause = excludedIds.length > 0
    ? `AND f.id NOT IN (${excludedIds.map(() => '?').join(', ')})`
    : '';
  const displayOrderClause = input.includeDisplayed ? '' : 'AND f.display_order IS NULL';
  const cutoffClause = includeAllUnviewed
    ? ''
    : 'AND COALESCE(f.created_at_ms, CAST(strftime(\'%s\', f.created_at) AS INTEGER) * 1000) >= ?';
  const typePlaceholders = carryForwardTypes.map(() => '?').join(', ');
  const queryParams = [
    ...carryForwardTypes,
    ...(cutoffMs === null ? [] : [cutoffMs]),
    ...excludedIds,
    ...interactionActions,
  ];
  const whereClause = `
    f.type IN (${typePlaceholders})
    ${cutoffClause}
    ${displayOrderClause}
    AND f.parent_id IS NULL
    AND f.id NOT LIKE 'reflection-%'
    AND COALESCE(json_extract(f.metadata, '$.reflectionCycle'), '') = ''
    ${excludedIdClause}
    AND NOT EXISTS (
      SELECT 1
      FROM interactions i
      WHERE i.feed_item_id = f.id
        AND i.action IN (${interactionPlaceholders})
    )
  `;

  const db = getDb();
  const eligibleCount = (db.prepare(`
    SELECT COUNT(*) AS count
    FROM feed f
    WHERE ${whereClause}
  `).get(...queryParams) as { count: number }).count;
  const reviewLimit = includeAllUnviewed ? eligibleCount : requestedReviewLimit;
  const queryLimit = includeAllUnviewed ? eligibleCount : limit;
  const rows = db.prepare(`
    SELECT
      f.id,
      f.type,
      f.source,
      f.source_id,
      f.author_username,
      f.title,
      f.text,
      f.excerpt,
      f.reason,
      f.url,
      f.created_at,
      COALESCE(f.created_at_ms, CAST(strftime('%s', f.created_at) AS INTEGER) * 1000) AS created_at_ms,
      f.published_at,
      f.display_order,
      CAST(json_extract(f.metadata, '$.interest.score') AS REAL) AS interest_score,
      json_extract(f.metadata, '$.interest.durability') AS interest_durability,
      -- Synthetic shipment ids are structural boundaries, not editorial threads.
      -- Recover historical agent thread evidence from metadata for possible regrouping.
      COALESCE(
        CASE
          WHEN TRIM(COALESCE(f.thread_id, '')) = 'carry-forward-unread'
            OR TRIM(COALESCE(f.thread_id, '')) LIKE 'shipment-singleton:%'
            OR TRIM(COALESCE(f.thread_id, '')) LIKE 'carry-forward-singleton:%'
          THEN NULL
          ELSE NULLIF(TRIM(f.thread_id), '')
        END,
        NULLIF(TRIM(json_extract(f.metadata, '$.thread.threadId')), ''),
        NULLIF(TRIM(json_extract(f.metadata, '$.threadId')), '')
      ) AS thread_id,
      COALESCE(
        NULLIF(TRIM(json_extract(f.metadata, '$.thread.threadTitle')), ''),
        NULLIF(TRIM(json_extract(f.metadata, '$.threadTitle')), '')
      ) AS thread_title,
      COALESCE(
        NULLIF(TRIM(json_extract(f.metadata, '$.thread.threadRationale')), ''),
        NULLIF(TRIM(json_extract(f.metadata, '$.threadRationale')), '')
      ) AS thread_rationale,
      NULLIF(TRIM(json_extract(f.metadata, '$.bridge')), '') AS bridge
    FROM feed f
    WHERE ${whereClause}
    -- Persisted display order is prior explicit shipment evidence. Rows that have
    -- never been arranged follow durable insertion sequence. Neither tier infers
    -- editorial value from age, source, type, popularity, taste, or preferences.
    ORDER BY
      CASE WHEN f.display_order IS NULL THEN 1 ELSE 0 END ASC,
      f.display_order ASC,
      f.rowid ASC,
      f.id ASC
    LIMIT ?
  `).all(...queryParams, reviewLimit) as CarryForwardRow[];

  const reviewed = rows.map(normalizeCarryForwardRow);
  const selected = reviewed.slice(0, queryLimit) as FeedCarryForwardCandidateList;
  selected.review = {
    includeAllUnviewed,
    includeDisplayed: input.includeDisplayed === true,
    cutoffMs,
    eligibleCount,
    reviewedCount: rows.length,
    returnedCount: selected.length,
    queryLimit,
    reviewLimit,
    candidateIds: selected.map((candidate) => candidate.id),
    orderBasis: 'prior_agent_shipment_then_evidence_sequence',
    generatedAtMs: nowMs,
  };
  return selected;
}

export function recordCarryForwardPromotions(ids: Iterable<string>, nowMs = Date.now()): number {
  const normalized = [...new Set([...ids].map((id) => (typeof id === 'string' ? id.trim() : '')).filter(Boolean))];
  if (normalized.length === 0) {
    return 0;
  }

  const db = getDb();
  const update = db.prepare(`
    UPDATE feed
    SET metadata = json_set(
      COALESCE(metadata, '{}'),
      '$.carryForward.promotedCount',
      COALESCE(CAST(json_extract(metadata, '$.carryForward.promotedCount') AS INTEGER), 0) + 1,
      '$.carryForward.lastPromotedAtMs',
      ?
    )
    WHERE id = ?
  `);
  let updated = 0;
  for (const id of normalized) {
    updated += update.run(nowMs, id).changes;
  }
  return updated;
}

export function validateFeedInterestInput(input: unknown, fieldPath = 'metadata.interest'): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return `${fieldPath} must be a JSON object when provided`;
  }
  const record = input as Record<string, unknown>;
  const score = record.score;
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) {
    return `${fieldPath}.score must be a number between 0 and 1`;
  }
  if (record.reason !== undefined && record.reason !== null) {
    if (typeof record.reason !== 'string') {
      return `${fieldPath}.reason must be a string when provided`;
    }
    if (record.reason.trim().length > 280) {
      return `${fieldPath}.reason must be 280 characters or fewer`;
    }
  }
  if (record.durability !== undefined && record.durability !== null) {
    if (normalizeInterestDurability(record.durability) === null) {
      return `${fieldPath}.durability must be one of: ${interestDurabilities.join(', ')}`;
    }
  }
  return null;
}
