import fs from 'node:fs';
import { getDb } from '@/lib/db/client';
import { getDataPath } from '@/lib/data-dir';

// The anticipation score measures how well Evogent put what the user wanted in front of
// them BEFORE they asked. Three inputs:
//   1. Demand events (anticipation_events): the user asked the agent for content/an action.
//      feed_hit — it was already in the feed (best case); cache_hit — the browse cache had
//      it so the answer took seconds (anticipated at the acquisition layer); miss — a live
//      browse was needed and the user waited minutes.
//   2. Engagement (interactions): the user engaged with items the curator chose — proof the
//      anticipation was right. Views stay NEUTRAL by contract ("views are never negative
//      signals" — and never positive here either); positive engagement is expand/like/thumbs.
//   3. Suggestion outcomes: an accepted suggestion is an anticipated ACTION that landed;
//      a dismissal is mild negative signal (suggestion fatigue guard).
// Weights are deliberately simple integers so the score reads as "net anticipations";
// data/anticipation-weights.json (user data, optional) overrides them per install.

export type AnticipationTier = 'feed_hit' | 'cache_hit' | 'miss';

export interface AnticipationWeights {
  feedHit: number;
  cacheHit: number;
  miss: number;
  expand: number;
  like: number;
  thumbsup: number;
  thumbsdown: number;
  acceptSuggestion: number;
  dismissSuggestion: number;
}

// Calibrated against production signal ratios (research 2026): a plain "like" is a weak
// positive (Twitter's like ≈ 1/27 of a reply); expand/read is stronger intent than a like;
// an accepted suggestion is an anticipated ACTION that landed (high value); dismiss is a mild
// fatigue signal, not a strong negative. All overridable via data/anticipation-weights.json.
export const DEFAULT_ANTICIPATION_WEIGHTS: AnticipationWeights = {
  feedHit: 5,
  cacheHit: 2,
  miss: -5,
  expand: 8,
  like: 5,
  thumbsup: 6,
  thumbsdown: -4,
  acceptSuggestion: 6,
  dismissSuggestion: -2,
};

// Anti-gaming: the score must not be inflatable by prefetching everything. Cached items that
// expire without the curator ever using them are waste, penalized at this per-item cost.
// Kept small so a healthy cache (most items used or still fresh) barely dents the score, but a
// bloated speculative cache drags it down. λ-style knob; overridable via the weights file.
export const DEFAULT_CACHE_POLLUTION_PENALTY = 0.5;

// Assumed wall-clock of a live computer-use browse when the user asks for something uncached.
// Used only for the user-facing TimeSaved stat (truthful, not gameable), not the headline score.
export const ASSUMED_LIVE_BROWSE_MS = 180_000;

export function readAnticipationWeights(): AnticipationWeights {
  try {
    const raw = fs.readFileSync(getDataPath('anticipation-weights.json'), 'utf8');
    const parsed = JSON.parse(raw) as Partial<AnticipationWeights>;
    return { ...DEFAULT_ANTICIPATION_WEIGHTS, ...parsed };
  } catch {
    return DEFAULT_ANTICIPATION_WEIGHTS;
  }
}

export interface AnticipationEventInput {
  tier: AnticipationTier;
  topics?: string[];
  sourceHint?: string | null;
  sessionId?: string | null;
  messageId?: string | null;
  waitedMs?: number | null;
  note?: string | null;
}

export interface AnticipationEventRecord {
  id: number;
  ts: string;
  tier: AnticipationTier;
  topics: string[];
  sourceHint: string | null;
  sessionId: string | null;
  messageId: string | null;
  waitedMs: number | null;
  note: string | null;
}

const VALID_TIERS = new Set<AnticipationTier>(['feed_hit', 'cache_hit', 'miss']);

export function sanitizeAnticipationTier(value: unknown): AnticipationTier | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase() as AnticipationTier;
  return VALID_TIERS.has(normalized) ? normalized : null;
}

export function sanitizeTopics(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const topics: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim().toLowerCase().slice(0, 80);
    if (trimmed && !topics.includes(trimmed)) topics.push(trimmed);
    if (topics.length >= 8) break;
  }
  return topics;
}

interface AnticipationEventRow {
  id: number;
  ts: string;
  tier: string;
  topics: string;
  source_hint: string | null;
  session_id: string | null;
  message_id: string | null;
  waited_ms: number | null;
  note: string | null;
}

function rowToEvent(row: AnticipationEventRow): AnticipationEventRecord {
  let topics: string[] = [];
  try {
    const parsed = JSON.parse(row.topics);
    if (Array.isArray(parsed)) topics = parsed.filter((t): t is string => typeof t === 'string');
  } catch { /* tolerate malformed rows */ }
  return {
    id: row.id,
    ts: row.ts,
    tier: (sanitizeAnticipationTier(row.tier) ?? 'miss'),
    topics,
    sourceHint: row.source_hint,
    sessionId: row.session_id,
    messageId: row.message_id,
    waitedMs: row.waited_ms,
    note: row.note,
  };
}

export function insertAnticipationEvent(input: AnticipationEventInput): AnticipationEventRecord {
  const tier = sanitizeAnticipationTier(input.tier);
  if (!tier) throw new Error(`invalid anticipation tier: ${String(input.tier)}`);
  const topics = sanitizeTopics(input.topics);
  const waitedMs = Number.isFinite(input.waitedMs) ? Math.max(0, Math.floor(Number(input.waitedMs))) : null;

  const result = getDb().prepare(`
    INSERT INTO anticipation_events (tier, topics, source_hint, session_id, message_id, waited_ms, note)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    tier,
    JSON.stringify(topics),
    input.sourceHint?.trim() || null,
    input.sessionId?.trim() || null,
    input.messageId?.trim() || null,
    waitedMs,
    input.note?.trim().slice(0, 500) || null,
  );

  const row = getDb().prepare(`
    SELECT id, ts, tier, topics, source_hint, session_id, message_id, waited_ms, note
    FROM anticipation_events
    WHERE id = ?
  `).get(result.lastInsertRowid) as AnticipationEventRow;

  return rowToEvent(row);
}

export function listAnticipationEvents(input?: { days?: number; limit?: number }): AnticipationEventRecord[] {
  const days = Math.max(1, Math.min(90, input?.days ?? 7));
  const limit = Math.max(1, Math.min(500, input?.limit ?? 100));
  const rows = getDb().prepare(`
    SELECT id, ts, tier, topics, source_hint, session_id, message_id, waited_ms, note
    FROM anticipation_events
    WHERE ts >= datetime('now', ?)
    ORDER BY ts DESC
    LIMIT ?
  `).all(`-${days} days`, limit) as AnticipationEventRow[];
  return rows.map(rowToEvent);
}

// Topics from recent misses that have not since been anticipated (no later feed_hit or
// cache_hit sharing the topic). These are the prefetch directives for the next browse cycle.
export function getUnresolvedMissTopics(input?: { days?: number; limit?: number }): Array<{
  topic: string;
  sourceHint: string | null;
  lastMissedAt: string;
  missCount: number;
}> {
  const days = Math.max(1, Math.min(30, input?.days ?? 3));
  const limit = Math.max(1, Math.min(20, input?.limit ?? 8));
  const events = listAnticipationEvents({ days, limit: 500 });

  const resolvedTopics = new Set<string>();
  for (const event of events) {
    if (event.tier === 'miss') continue;
    for (const topic of event.topics) resolvedTopics.add(topic);
  }

  const byTopic = new Map<string, { topic: string; sourceHint: string | null; lastMissedAt: string; missCount: number }>();
  // events are newest-first; keep the newest sourceHint/timestamp per topic.
  for (const event of events) {
    if (event.tier !== 'miss') continue;
    for (const topic of event.topics) {
      if (resolvedTopics.has(topic)) continue;
      const existing = byTopic.get(topic);
      if (existing) {
        existing.missCount += 1;
      } else {
        byTopic.set(topic, {
          topic,
          sourceHint: event.sourceHint,
          lastMissedAt: event.ts,
          missCount: 1,
        });
      }
    }
  }

  return Array.from(byTopic.values())
    .sort((a, b) => b.missCount - a.missCount || b.lastMissedAt.localeCompare(a.lastMissedAt))
    .slice(0, limit);
}

export interface AnticipationScore {
  windowDays: number;
  score: number;
  adjustedScore: number;
  demand: { feedHits: number; cacheHits: number; misses: number; demandHitRate: number | null };
  engagement: Record<string, number>;
  cache: { cachePollutionRate: number | null; wastedItems: number; consumedOrFresh: number; total: number };
  timeSavedMinutes: number;
  dailySeries: Array<{ date: string; score: number }>;
  topMissedTopics: Array<{ topic: string; sourceHint: string | null; lastMissedAt: string; missCount: number }>;
  weights: AnticipationWeights;
}

const ENGAGEMENT_ACTIONS: Array<{ action: string; weightKey: keyof AnticipationWeights }> = [
  { action: 'expand', weightKey: 'expand' },
  { action: 'like', weightKey: 'like' },
  { action: 'thumbsup', weightKey: 'thumbsup' },
  { action: 'thumbsdown', weightKey: 'thumbsdown' },
  { action: 'accept_suggestion', weightKey: 'acceptSuggestion' },
  { action: 'dismiss_suggestion', weightKey: 'dismissSuggestion' },
];

export function computeAnticipationScore(input?: { days?: number }): AnticipationScore {
  const windowDays = Math.max(1, Math.min(90, input?.days ?? 7));
  const weights = readAnticipationWeights();
  const db = getDb();
  const cutoff = `-${windowDays} days`;

  const demandRows = db.prepare(`
    SELECT tier, COUNT(*) AS count, substr(ts, 1, 10) AS day
    FROM anticipation_events
    WHERE ts >= datetime('now', ?)
    GROUP BY tier, day
  `).all(cutoff) as Array<{ tier: string; count: number; day: string }>;

  const engagementRows = db.prepare(`
    SELECT action, COUNT(*) AS count, substr(created_at, 1, 10) AS day
    FROM interactions
    WHERE created_at >= datetime('now', ?)
    GROUP BY action, day
  `).all(cutoff) as Array<{ action: string; count: number; day: string }>;

  const demand = { feedHits: 0, cacheHits: 0, misses: 0, demandHitRate: null as number | null };
  const engagement: Record<string, number> = {};
  const daily = new Map<string, number>();
  const bump = (day: string, delta: number) => daily.set(day, (daily.get(day) ?? 0) + delta);

  let score = 0;
  for (const row of demandRows) {
    const tier = sanitizeAnticipationTier(row.tier);
    if (!tier) continue;
    let delta = 0;
    if (tier === 'feed_hit') { demand.feedHits += row.count; delta = weights.feedHit * row.count; }
    if (tier === 'cache_hit') { demand.cacheHits += row.count; delta = weights.cacheHit * row.count; }
    if (tier === 'miss') { demand.misses += row.count; delta = weights.miss * row.count; }
    score += delta;
    bump(row.day, delta);
  }

  const demandTotal = demand.feedHits + demand.cacheHits + demand.misses;
  if (demandTotal > 0) {
    demand.demandHitRate = Math.round(((demand.feedHits + demand.cacheHits) / demandTotal) * 100) / 100;
  }

  for (const row of engagementRows) {
    const mapping = ENGAGEMENT_ACTIONS.find((entry) => entry.action === row.action);
    if (!mapping) continue;
    engagement[row.action] = (engagement[row.action] ?? 0) + row.count;
    const delta = weights[mapping.weightKey] * row.count;
    score += delta;
    bump(row.day, delta);
  }

  const dailySeries = Array.from(daily.entries())
    .map(([date, dayScore]) => ({ date, score: dayScore }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Anti-gaming cost side: of the items that have already left the cache (expired), how many
  // were never consumed by curation? A healthy pipeline uses or keeps most of what it caches;
  // a bloated speculative cache wastes acquisition budget and drags the adjusted score down.
  const cacheRow = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN seen_by_curation_at_ms IS NOT NULL THEN 1 ELSE 0 END) AS consumed
    FROM browse_cache_items
    WHERE fetched_at_ms >= ?
  `).get(Date.now() - windowDays * 24 * 60 * 60 * 1000) as { total: number; consumed: number | null };

  const expiredRow = db.prepare(`
    SELECT COUNT(*) AS wasted
    FROM browse_cache_items
    WHERE expires_at_ms < ?
      AND seen_by_curation_at_ms IS NULL
      AND fetched_at_ms >= ?
  `).get(Date.now(), Date.now() - windowDays * 24 * 60 * 60 * 1000) as { wasted: number };

  const cacheTotal = cacheRow.total ?? 0;
  const wastedItems = expiredRow.wasted ?? 0;
  const consumedOrFresh = Math.max(0, cacheTotal - wastedItems);
  const cachePollutionRate = cacheTotal > 0 ? Math.round((wastedItems / cacheTotal) * 100) / 100 : null;
  const pollutionPenalty = wastedItems * DEFAULT_CACHE_POLLUTION_PENALTY;
  const adjustedScore = Math.round((score - pollutionPenalty) * 100) / 100;

  // Truthful user-facing stat: minutes of live-browsing the user did NOT have to wait through
  // because the answer was already in the feed (full baseline) or the cache (baseline minus the
  // actual wait). Additive and not gameable by over-caching.
  let timeSavedMs = 0;
  const savedRows = db.prepare(`
    SELECT tier, waited_ms FROM anticipation_events WHERE ts >= datetime('now', ?)
  `).all(cutoff) as Array<{ tier: string; waited_ms: number | null }>;
  for (const row of savedRows) {
    if (row.tier === 'feed_hit') timeSavedMs += ASSUMED_LIVE_BROWSE_MS;
    else if (row.tier === 'cache_hit') {
      timeSavedMs += Math.max(0, ASSUMED_LIVE_BROWSE_MS - (row.waited_ms ?? 0));
    }
  }

  return {
    windowDays,
    score,
    adjustedScore,
    demand,
    engagement,
    cache: { cachePollutionRate, wastedItems, consumedOrFresh, total: cacheTotal },
    timeSavedMinutes: Math.round(timeSavedMs / 60000),
    dailySeries,
    topMissedTopics: getUnresolvedMissTopics({ days: Math.min(windowDays, 7) }),
    weights,
  };
}
