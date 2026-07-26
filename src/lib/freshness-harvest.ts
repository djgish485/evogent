import { createHash } from 'node:crypto';
import {
  listUnseenShipmentCacheItems,
  markBrowseCacheItemsSeen,
  type BrowseCacheItemRecord,
} from '@/lib/db/browse-cache';
import { insertBenchItems, type BenchInsertInput } from '@/lib/db/curation-bench';
import { fetchPublicHttpText } from '@/lib/public-http';

/**
 * Agent-judged fallback. The full curator is a heavy actor that can occasionally fail while
 * useful content waits in the cache. A lightweight on-phone agent therefore makes
 * the editorial shipment judgment for each eligible row: ship or hold, an ordering rank, a
 * concise public reason, and (only when real) a topical cluster.
 *
 * This module is mechanics only: validate that judgment, deduplicate, cap, derive stable
 * identities, transform already-grounded source material, and move it through the ordinary
 * validated bench. It never creates an editorial score or minimum output, boosts a source or
 * account, or fabricates a thread.
 */

// Sources whose already-judged fresh rows can be transformed, and the feed type they map to.
const HARVEST_SOURCES: Array<{ source: string; type: 'tweet' | 'article' }> = [
  { source: 'twitter', type: 'tweet' },
  { source: 'hackernews', type: 'article' },
  { source: 'substack', type: 'article' },
  { source: 'instagram', type: 'tweet' },
  { source: 'events', type: 'article' }, // standing-interest upcoming events (browse-interests.py)
];

const MIN_PUBLISH_AGE_MS = 90 * 1000; // submit rejects publish dates within 60s of now; stay clear
const ENRICH_FETCH_TIMEOUT_MS = 5000;
const MAX_GLOBAL_SHIPMENTS = 50;
const MAX_ENRICH_FETCHES = 12;
const SHIPMENT_SCHEMA = 'evogent.freshness-shipment.v1';
const MAX_PUBLIC_REASON_LENGTH = 200;
const MAX_CLUSTER_TITLE_LENGTH = 100;
const CLUSTER_KEY_RE = /^[a-z0-9][a-z0-9._:-]{0,79}$/;
const ENRICH_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

export interface FreshnessShipmentJudgment {
  schema: typeof SHIPMENT_SCHEMA;
  decision: 'ship' | 'hold';
  /** Agent-provided value/order judgment in [0,1]. Mechanics copy it; they never derive it. */
  rank: number;
  /** Public, content-centered explanation. Private preference evidence must never appear here. */
  reason: string;
  cluster?: {
    /** Agent-provided stable semantic key; mechanics only validate and hash it. */
    key: string;
    title: string;
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function singleLine(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string' || /[\r\n]/.test(value)) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : null;
}

/**
 * Read only the explicit v1 shipment contract. Legacy numeric-only `tasteScore` rows are
 * deliberately ignored and remain awaiting judgment; a number is not a ship decision.
 */
export function readFreshnessShipmentJudgment(row: BrowseCacheItemRecord): FreshnessShipmentJudgment | null {
  const raw = record((row.payload as { shipmentJudgment?: unknown }).shipmentJudgment);
  if (!raw || raw.schema !== SHIPMENT_SCHEMA) return null;
  if (raw.decision !== 'ship' && raw.decision !== 'hold') return null;
  if (typeof raw.rank !== 'number' || !Number.isFinite(raw.rank) || raw.rank < 0 || raw.rank > 1) return null;
  const reason = singleLine(raw.reason, MAX_PUBLIC_REASON_LENGTH);
  if (!reason) return null;

  const rawCluster = raw.cluster === undefined ? null : record(raw.cluster);
  let cluster: FreshnessShipmentJudgment['cluster'];
  if (raw.cluster !== undefined) {
    const key = rawCluster ? singleLine(rawCluster.key, 80) : null;
    const title = rawCluster ? singleLine(rawCluster.title, MAX_CLUSTER_TITLE_LENGTH) : null;
    if (!key || !CLUSTER_KEY_RE.test(key) || !title) return null;
    cluster = { key, title };
  }
  return {
    schema: SHIPMENT_SCHEMA,
    decision: raw.decision,
    rank: raw.rank,
    reason,
    ...(cluster ? { cluster } : {}),
  };
}

function stableHash(parts: string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 20);
}

export function stableShipmentId(row: Pick<BrowseCacheItemRecord, 'source' | 'sourceId'>): string {
  return `shipment-${stableHash([row.source, row.sourceId])}`;
}

function stableClusterThread(cluster: NonNullable<FreshnessShipmentJudgment['cluster']>): Record<string, unknown> {
  return {
    threadId: `shipment-cluster-${stableHash([cluster.key, cluster.title])}`,
    threadTitle: cluster.title,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    promise.catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

/** Fetch an article's own synopsis (og:description / meta description) so a link-post can ship
 *  as an article without the curator. Deterministic, no brain. Returns null on any failure.
 *  Double-guarded: AbortSignal AND an outer race, because some hung connections ignore the
 *  abort signal and would otherwise block the whole harvest indefinitely. */
async function fetchArticleSynopsis(url: string): Promise<string | null> {
  const run = async (): Promise<string | null> => {
    const res = await fetchPublicHttpText(url, {
      timeoutMs: ENRICH_FETCH_TIMEOUT_MS,
      maxBytes: 262_144,
      headers: { 'user-agent': ENRICH_USER_AGENT },
    });
    if (res.status < 200 || res.status >= 300) return null;
    const html = res.text;
    const m = html.match(/<meta[^>]+(?:property|name)=["']og:description["'][^>]+content=["']([^"']+)/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:description["']/i)
      || html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i);
    if (!m) return null;
    const text = m[1]
      .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .trim();
    return text ? text.slice(0, 600) : null;
  };
  return withTimeout(run(), ENRICH_FETCH_TIMEOUT_MS + 1500);
}

/**
 * Transform a cache row into a curate/submit-ready item, or null if it can't ship cleanly.
 * Never fabricates: an article with only a title (no real synopsis) returns null rather than
 * ship a title-as-body that submit would (rightly) reject.
 */
export function cacheRowToFeedItem(
  row: BrowseCacheItemRecord,
  type: 'tweet' | 'article',
  judgment: FreshnessShipmentJudgment,
  nowMs: number,
): Record<string, unknown> | null {
  const p = row.payload ?? {};
  if (judgment.decision !== 'ship') return null;
  // Instagram (and other a11y-scraped social sources) expose no post timestamp in the
  // accessibility tree, so publishedAtMs is null and every IG row was being rejected here —
  // which is why IG vanished from the feed after any real curation (verify-intents caught it).
  // Fetch time is the honest proxy for image-social cards: it's when we actually saw the post.
  const publishedAtMs = row.publishedAtMs ?? ((row.source === 'instagram' || row.source === 'events') ? row.fetchedAtMs : null);
  if (!publishedAtMs || nowMs - publishedAtMs < MIN_PUBLISH_AGE_MS) return null;
  const publishedAt = new Date(publishedAtMs).toISOString();

  const interest = {
    score: judgment.rank,
    reason: judgment.reason,
  };
  const baseMeta = {
    interest,
    source: row.source,
    freshnessFloor: true,
    shipment: {
      id: stableShipmentId(row),
      decision: judgment.decision,
      rank: judgment.rank,
      reason: judgment.reason,
      ...(judgment.cluster ? { cluster: judgment.cluster } : {}),
    },
  };

  // Standing-interest events: a "keep me updated on X" venue's upcoming happening. Ships as an
  // article-shaped card carrying event metadata (date/time/location) so the card can render an
  // event header; url is optional (venue page when there's no per-event link). browse-interests
  // only ever caches events dated today-or-later and re-caches them each cycle, so the floor keeps
  // them fresh until they happen, then they naturally drop out.
  if (row.source === 'events') {
    const title = row.title || (typeof p.title === 'string' ? p.title : '');
    const text = [p.text, p.description, p.synopsis]
      .map((v) => (typeof v === 'string' ? v.trim() : ''))
      .find((v) => v.length > 0) || '';
    if (!title || !text) return null;
    const entity = (typeof p.entity === 'string' && p.entity.trim()) || row.authorDisplayName || '';
    return {
      type: 'article',
      source: 'events',
      sourceId: row.sourceId,
      title,
      url: row.url || (typeof p.url === 'string' ? p.url : '') || null,
      publishedAt,
      text,
      ...(entity ? { authorDisplayName: entity, authorUsername: entity } : {}),
      metadata: {
        ...baseMeta,
        event: {
          date: typeof p.eventDate === 'string' ? p.eventDate : undefined,
          time: typeof p.time === 'string' ? p.time : undefined,
          location: typeof p.location === 'string' ? p.location : undefined,
          entity: typeof p.entity === 'string' ? p.entity : undefined,
          interestId: typeof p.interestId === 'string' ? p.interestId : undefined,
        },
      },
    };
  }

  if (type === 'tweet') {
    if (row.source === 'instagram') {
      // Instagram rows carry the caption in title/text as "<username> <caption>" and no post
      // URL (the a11y browse can't read permalinks). Ship the caption as a social card with
      // the author's profile as the tap-through — opens the Instagram app on their profile.
      const author = row.authorUsername || (typeof p.author === 'string' ? p.author : '');
      let caption = (typeof p.text === 'string' && p.text.trim())
        || (typeof p.caption === 'string' && p.caption.trim())
        || (typeof row.title === 'string' ? row.title.trim() : '');
      if (author && caption.toLowerCase().startsWith(author.toLowerCase())) {
        caption = caption.slice(author.length).trim();
      }
      const igMedia = Array.isArray(p.mediaUrls) && p.mediaUrls.length ? (p.mediaUrls as string[]) : [];
      // A caption OR a captured post image is enough — an image with a one-word caption is still a
      // real card (the image is the content). Without either, there's nothing to show.
      if (!author || (!caption && igMedia.length === 0)) return null;
      // Story rows carry a real /stories/<handle>/ deep link (opens the story in the IG app);
      // ordinary posts keep the author-profile fallback since a11y exposes no post permalink.
      const rowUrl = typeof row.url === 'string' && /instagram\.com\/stories\//.test(row.url) ? row.url : '';
      // Story records are ephemeral source snapshots; retain only reusable post metadata.
      const brainNote = typeof p.brainNote === 'string' && p.brainNote.trim() ? p.brainNote.trim() : '';
      return {
        type: 'tweet',
        source: 'instagram',
        sourceId: row.sourceId,
        title: null,
        url: rowUrl || `https://www.instagram.com/${author}/`,
        authorUsername: author,
        authorDisplayName: row.authorDisplayName
          || (typeof p.authorDisplayName === 'string' && p.authorDisplayName.trim() ? p.authorDisplayName.trim() : '')
          || author,
        publishedAt,
        text: p.story === true ? '' : caption,
        ...(igMedia.length ? { mediaUrls: igMedia } : {}),
        metadata: brainNote ? { ...baseMeta, brainNote } : baseMeta,
      };
    }
    const text = typeof p.text === 'string' ? p.text.trim() : '';
    const url = row.url || (typeof p.url === 'string' ? p.url : '');
    const author = row.authorUsername || (typeof p.authorUsername === 'string' ? p.authorUsername : '');
    const handleUncertain = p.handleUncertain === true;
    const mediaUrls = Array.isArray(p.mediaUrls)
      ? p.mediaUrls.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : [];
    const quotedTweet = record(p.quotedTweet);
    const quotedText = typeof quotedTweet?.text === 'string' ? quotedTweet.text.trim() : '';
    const mediaDescription = typeof p.mediaDescription === 'string'
      ? p.mediaDescription.trim()
      : '';
    // A /status/ permalink is ideal; a profile URL is allowed only when the scraper actually saw
    // the handle. When X exposes just a display name, the scraper intentionally emits no URL and
    // marks the derived handle uncertain. That is still honest, source-owned content: ship the
    // agent-approved card with an in-app destination instead of dropping it or inventing a link.
    const tappableX = /\/status\/\d+/.test(url) || /^https?:\/\/(x|twitter)\.com\/[A-Za-z0-9_]+\/?$/.test(url);
    const honestInAppOnly = handleUncertain && !url;
    if ((!text && mediaUrls.length === 0 && !quotedText)
      || (!tappableX && !honestInAppOnly)
      || !author) return null;
    return {
      type: 'tweet',
      source: 'twitter',
      sourceId: row.sourceId,
      title: null,
      url: url || null,
      authorUsername: author,
      authorDisplayName: row.authorDisplayName || (typeof p.authorDisplayName === 'string' ? p.authorDisplayName : author),
      publishedAt,
      // Accessibility descriptions remain provenance evidence in the cache; they are not the
      // author's post body. A true media-only card carries its captured media URL.
      text,
      ...(mediaUrls.length ? { mediaUrls } : {}),
      ...(typeof p.authorAvatarUrl === 'string' && p.authorAvatarUrl ? { authorAvatarUrl: p.authorAvatarUrl } : {}),
      metadata: {
        ...baseMeta,
        ...(handleUncertain ? { handleUncertain: true } : {}),
        metrics: (p.metrics && typeof p.metrics === 'object') ? p.metrics : undefined,
        ...(quotedTweet ? { quotedTweet } : {}),
        ...(mediaDescription ? { mediaDescription } : {}),
      },
    };
  }

  // article: only ship when the payload carries a real synopsis distinct from the title.
  // HN cache rows already carry linkedArticleSynopsis (the source skill fetches it at browse
  // time) — read that first so most HN articles ship with ZERO enrichment fetches.
  const title = row.title || (typeof p.title === 'string' ? p.title : '');
  const synopsis = [p.linkedArticleSynopsis, p.text, p.snippet, p.summary, p.description]
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .find((v) => v.length > 0 && v.toLowerCase() !== title.toLowerCase());
  const url = row.url || (typeof p.url === 'string' ? p.url : '');
  if (!synopsis || !title || !url) return null;
  return {
    type: 'article',
    source: row.source,
    sourceId: row.sourceId,
    title,
    url,
    publishedAt,
    text: synopsis,
    metadata: baseMeta,
  };
}

export interface HarvestResult {
  scanned: number;
  awaitingJudgment: number;
  heldByAgent: number;
  benched: number;
  bySource: Record<string, number>;
}

interface ShipmentCandidate {
  row: BrowseCacheItemRecord;
  item: Record<string, unknown>;
  judgment: FreshnessShipmentJudgment;
  shipmentId: string;
}

/** Add a banner only when the agent assigned at least two selected members to the same cluster. */
function applyAgentClusters(chosen: ShipmentCandidate[]): void {
  const groups = new Map<string, ShipmentCandidate[]>();
  for (const candidate of chosen) {
    const cluster = candidate.judgment.cluster;
    if (!cluster) continue;
    const key = `${cluster.key}\0${cluster.title}`;
    const members = groups.get(key) ?? [];
    members.push(candidate);
    groups.set(key, members);
  }
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const cluster = members[0].judgment.cluster;
    if (!cluster) continue;
    const thread = stableClusterThread(cluster);
    for (const member of members) {
      const metadata = record(member.item.metadata);
      if (metadata) metadata.thread = thread;
    }
  }
}

/**
 * Validate explicit shipment judgments for unexpired unseen cache rows and bench the agent's
 * highest-ranked `ship` decisions. Article rows without a payload synopsis are mechanically
 * enriched (og:description fetch) when `enrich` is set. No output is required: an agent may
 * hold every row. Marks selected rows seen; the caller promotes the bench into the visible feed.
 */
export async function harvestFreshToBench(limit = 12, opts: { enrich?: boolean } = {}): Promise<HarvestResult> {
  const nowMs = Date.now();
  const enrich = opts.enrich === true;
  const shipmentLimit = Math.max(0, Math.min(MAX_GLOBAL_SHIPMENTS, Math.floor(Number.isFinite(limit) ? limit : 0)));

  // Gather only explicit ship decisions. Source, account, content type, recency, engagement, and
  // favorite status never alter the agent-provided ordering rank.
  const rowsByType: Array<{
    row: BrowseCacheItemRecord;
    type: 'tweet' | 'article';
    judgment: FreshnessShipmentJudgment;
    shipmentId: string;
  }> = [];
  let scanned = 0;
  let awaitingJudgment = 0;
  let heldByAgent = 0;
  const typeBySource = new Map(HARVEST_SOURCES.map(({ source, type }) => [source, type] as const));
  const rows = listUnseenShipmentCacheItems(
    HARVEST_SOURCES.map(({ source }) => source),
    nowMs,
  );
  for (const row of rows) {
    const type = typeBySource.get(row.source);
    if (!type) continue;
    scanned += 1;
    const judgment = readFreshnessShipmentJudgment(row);
    if (!judgment) {
      awaitingJudgment += 1;
      continue;
    }
    if (judgment.decision === 'hold') {
      heldByAgent += 1;
      continue;
    }
    rowsByType.push({ row, type, judgment, shipmentId: stableShipmentId(row) });
  }
  rowsByType.sort((a, b) => b.judgment.rank - a.judgment.rank
    || a.shipmentId.localeCompare(b.shipmentId));
  // Text-level dedup before ranking competes for slots: sources can re-ingest the same post
  // under different ids, so keep the instance the agent ranked highest.
  const seenText = new Set<string>();
  const dedupedRows = rowsByType.filter(({ row }) => {
    const t = (typeof row.payload?.text === 'string' ? row.payload.text : '')
      .toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 300);
    if (t.length < 20) return true; // media-only/short rows: ids are the identity
    if (seenText.has(t)) return false;
    seenText.add(t);
    return true;
  });

  if (shipmentLimit === 0) {
    return { scanned, awaitingJudgment, heldByAgent, benched: 0, bySource: {} };
  }

  // Build items. First pass: rows that ship as-is. Enrich only the top few article rows that
  // lack a synopsis, bounded, so we don't fetch dozens of URLs per harvest.
  const candidates: ShipmentCandidate[] = [];
  const needEnrich: Array<{
    row: BrowseCacheItemRecord;
    judgment: FreshnessShipmentJudgment;
    shipmentId: string;
  }> = [];
  for (const { row, type, judgment, shipmentId } of dedupedRows) {
    const item = cacheRowToFeedItem(row, type, judgment, nowMs);
    if (item) {
      candidates.push({ row, item, judgment, shipmentId });
      continue;
    }
    if (enrich && type === 'article' && needEnrich.length < MAX_ENRICH_FETCHES) {
      const url = row.url || (typeof row.payload?.url === 'string' ? row.payload.url as string : '');
      if (/^https?:\/\//.test(url)) needEnrich.push({ row, judgment, shipmentId });
    }
  }

  if (needEnrich.length > 0) {
    const enrichmentLimit = Math.min(MAX_ENRICH_FETCHES, shipmentLimit);
    const enriched = await Promise.all(needEnrich.slice(0, enrichmentLimit).map(async ({
      row, judgment, shipmentId,
    }) => {
      const url = row.url || (typeof row.payload?.url === 'string' ? row.payload.url as string : '');
      const synopsis = await fetchArticleSynopsis(url);
      if (!synopsis) return null;
      // Inject the fetched synopsis so the transformer produces a valid article body.
      const enrichedRow: BrowseCacheItemRecord = { ...row, payload: { ...row.payload, text: synopsis } };
      const item = cacheRowToFeedItem(enrichedRow, 'article', judgment, nowMs);
      return item ? { row, item, judgment, shipmentId } : null;
    }));
    for (const e of enriched) if (e) candidates.push(e);
  }

  candidates.sort((a, b) => b.judgment.rank - a.judgment.rank
    || a.shipmentId.localeCompare(b.shipmentId));
  const chosen = candidates.slice(0, shipmentLimit);
  if (chosen.length === 0) {
    return { scanned, awaitingJudgment, heldByAgent, benched: 0, bySource: {} };
  }
  applyAgentClusters(chosen);

  const benchInputs: BenchInsertInput[] = chosen.map(({ row, item, judgment }) => ({
    cycleId: `freshness-shipment-${new Date(nowMs).toISOString().slice(0, 13)}`,
    source: row.source,
    sourceId: row.sourceId,
    score: judgment.rank,
    reason: judgment.reason,
    itemJson: JSON.stringify(item),
  }));
  const benched = insertBenchItems(benchInputs);
  // Mark harvested rows seen so they don't re-bench each open (they're now the curator's call
  // or already in the pipeline). Promotion/dedup at submit protects against double-shipping.
  markBrowseCacheItemsSeen(chosen.map(({ row }) => ({ source: row.source, sourceId: row.sourceId })));

  const bySource: Record<string, number> = {};
  for (const { row } of chosen) bySource[row.source] = (bySource[row.source] ?? 0) + 1;
  return { scanned, awaitingJudgment, heldByAgent, benched, bySource };
}
