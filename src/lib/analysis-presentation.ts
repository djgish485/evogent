import { getFeedMediaItems } from '@/lib/feed-media';
import type { AnalysisPresentation, FeedItem, FeedItemType, FeedReferenceItem, MediaItem } from '@/types/feed';

export interface AnalysisSeriesItemEntry {
  kind: 'item';
  item: FeedItem;
}

export interface AnalysisSeriesBundleEntry {
  kind: 'series';
  key: string;
  title: string;
  labels: string[];
  items: FeedItem[];
  leadItem: FeedItem;
  latestTimestamp: string;
}

export type AnalysisRenderableEntry = AnalysisSeriesItemEntry | AnalysisSeriesBundleEntry;

function normalizeComparableText(value: string | null | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateLabel(value: string, maxLength: number): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLength) {
    return collapsed;
  }
  return `${collapsed.slice(0, maxLength - 1).trimEnd()}…`;
}

function firstMeaningfulSentence(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (!collapsed) {
    return '';
  }

  const sentence = collapsed.split(/(?<=[.!?])\s+/u)[0]?.trim() ?? '';
  return sentence || collapsed;
}

function hasMeaningfulTitleOverlap(candidate: string, reference: string): boolean {
  const normalizedCandidate = normalizeComparableText(candidate);
  const normalizedReference = normalizeComparableText(reference);

  if (!normalizedCandidate || !normalizedReference) {
    return false;
  }

  if (normalizedCandidate === normalizedReference) {
    return true;
  }

  if (
    normalizedCandidate.length >= Math.floor(normalizedReference.length * 0.75)
    && normalizedReference.includes(normalizedCandidate)
  ) {
    return true;
  }

  if (
    normalizedReference.length >= Math.floor(normalizedCandidate.length * 0.75)
    && normalizedCandidate.includes(normalizedReference)
  ) {
    return true;
  }

  return false;
}

function buildFeedReferenceItem(item: FeedItem): FeedReferenceItem {
  return {
    id: item.id,
    type: item.type,
    title: item.title,
    text: item.text,
    url: item.url,
    source: item.source,
    authorDisplayName: item.authorDisplayName,
    authorUsername: item.authorUsername,
  };
}

function isPrimarySynthesisItem(item: FeedItem | null | undefined): item is FeedItem {
  return item?.type === 'tweet' || item?.type === 'article';
}

function addUniqueItem(target: FeedItem[], seenIds: Set<string>, item: FeedItem | null | undefined): void {
  if (!item || seenIds.has(item.id)) {
    return;
  }

  seenIds.add(item.id);
  target.push(item);
}

function buildSourceKeyCandidates(item: FeedItem): string[] {
  const candidates = new Set<string>();

  if (item.sourceId?.trim()) {
    candidates.add(item.sourceId.trim().toLowerCase());
  }

  if (item.url?.trim()) {
    candidates.add(item.url.trim().toLowerCase());
  }

  if (item.metadata?.linkCard?.url?.trim()) {
    candidates.add(item.metadata.linkCard.url.trim().toLowerCase());
  }

  for (const preview of item.metadata?.linkPreviews ?? []) {
    if (preview.url?.trim()) {
      candidates.add(preview.url.trim().toLowerCase());
    }
  }

  return Array.from(candidates);
}

function buildContextLookup(items: FeedItem[]): Map<string, FeedItem[]> {
  const lookup = new Map<string, FeedItem[]>();

  for (const item of items) {
    if (item.type === 'suggestion' || item.type === 'notification') {
      continue;
    }

    for (const key of buildSourceKeyCandidates(item)) {
      const current = lookup.get(key) ?? [];
      current.push(item);
      lookup.set(key, current);
    }
  }

  return lookup;
}

function resolveSourceItems(item: FeedItem, contextLookup: Map<string, FeedItem[]>): FeedItem[] {
  const resolved: FeedItem[] = [];
  const seenIds = new Set<string>();

  addUniqueItem(
    resolved,
    seenIds,
    isPrimarySynthesisItem(item.parentItem) ? item.parentItem : null,
  );

  for (const key of buildSourceKeyCandidates(item)) {
    const matches = contextLookup.get(key) ?? [];
    for (const match of matches) {
      if (match.id === item.id || !isPrimarySynthesisItem(match)) {
        continue;
      }
      addUniqueItem(resolved, seenIds, match);
    }
  }

  return resolved;
}

function getReferenceLabel(item: FeedItem): string {
  if (item.type === 'tweet') {
    if (item.authorDisplayName?.trim()) {
      return item.authorDisplayName.trim();
    }
    if (item.authorUsername?.trim()) {
      return `@${item.authorUsername.trim().replace(/^@+/, '')}`;
    }
  }

  if (item.title?.trim()) {
    return truncateLabel(item.title.trim(), 56);
  }

  return truncateLabel(firstMeaningfulSentence(item.text), 56) || 'Source';
}

function getPreferredHeroMedia(item: FeedItem): MediaItem[] {
  return getFeedMediaItems(item);
}

function buildConciseTitle(item: FeedItem, sourceItems: FeedItem[]): string | null {
  const referenceTitle = sourceItems[0]?.title?.trim()
    || sourceItems[0]?.text?.trim()
    || '';
  const title = item.title?.trim() ?? '';
  const reason = item.reason?.trim() ?? '';
  const sentence = firstMeaningfulSentence(item.text);

  const titleCandidate = title && !hasMeaningfulTitleOverlap(title, referenceTitle)
    ? title
    : '';
  const reasonCandidate = reason && !hasMeaningfulTitleOverlap(reason, referenceTitle)
    ? reason
    : '';

  const chosen = titleCandidate || reasonCandidate || sentence || title || reason;
  if (!chosen) {
    return null;
  }

  return truncateLabel(chosen, 88);
}

function buildConciseLabel(item: FeedItem, conciseTitle: string | null): string {
  if (conciseTitle) {
    return truncateLabel(conciseTitle, 44);
  }

  const fallback = item.title?.trim()
    || item.reason?.trim()
    || firstMeaningfulSentence(item.text)
    || 'Analysis';

  return truncateLabel(fallback, 44);
}

function scoreAnalysis(item: FeedItem, sourceItems: FeedItem[], conciseTitle: string | null): number {
  let score = 0;
  const textLength = item.text.trim().length;
  const paragraphCount = item.text.split(/\n\s*\n/g).filter((paragraph) => paragraph.trim().length > 0).length;
  const hasMarkdownStructure = /(^|\n)#{2,6}\s+\S/.test(item.text) || /(^|\n)[*-]\s+\S/.test(item.text);
  const sourcePreviewCount = sourceItems.length + (item.metadata?.linkPreviews?.length ?? 0);

  if (textLength >= 900) {
    score += 3;
  } else if (textLength >= 450) {
    score += 2;
  } else if (textLength >= 240) {
    score += 1;
  }

  if (paragraphCount >= 3) {
    score += 1;
  }

  if (hasMarkdownStructure) {
    score += 1;
  }

  if (sourcePreviewCount >= 2) {
    score += 1;
  }

  if (conciseTitle && conciseTitle.trim().length > 0) {
    score += 1;
  }

  return score;
}

function sortFeedItemsByRecency(left: FeedItem, right: FeedItem): number {
  const byCreated = right.createdAt.localeCompare(left.createdAt);
  if (byCreated !== 0) {
    return byCreated;
  }
  return right.publishedAt.localeCompare(left.publishedAt);
}

export function deriveAnalysisPresentation(
  item: FeedItem,
  contextItems: FeedItem[],
): AnalysisPresentation | null {
  if (item.type !== 'analysis') {
    return null;
  }

  const contextLookup = buildContextLookup(contextItems);
  const sourceItems = resolveSourceItems(item, contextLookup);
  const conciseTitle = buildConciseTitle(item, sourceItems);
  const conciseLabel = buildConciseLabel(item, conciseTitle);
  const promotionScore = scoreAnalysis(item, sourceItems, conciseTitle);
  const primarySource = sourceItems[0] ?? null;
  const heroMedia = primarySource ? getPreferredHeroMedia(primarySource) : [];

  return {
    conciseTitle,
    conciseLabel,
    promotionScore,
    seriesKey: primarySource ? `analysis-series:${primarySource.id}` : null,
    seriesLabel: primarySource ? getReferenceLabel(primarySource) : null,
    heroMedia,
    heroMediaSource: primarySource ? buildFeedReferenceItem(primarySource) : null,
    sourceItems: sourceItems.map(buildFeedReferenceItem),
  };
}

function buildSeriesTitle(entry: FeedItem): string {
  const seriesLabel = entry.analysisPresentation?.seriesLabel?.trim();
  if (seriesLabel) {
    return `${seriesLabel} analysis`;
  }
  return 'Related analysis';
}

function getEntryTimestamp(item: FeedItem): string {
  return item.createdAt || item.publishedAt;
}

export function buildAnalysisRenderableEntries(
  items: FeedItem[],
): AnalysisRenderableEntry[] {
  const groups = new Map<string, FeedItem[]>();
  const orderedKeys: string[] = [];

  for (const item of items) {
    const key = item.analysisPresentation?.seriesKey ?? `analysis:${item.id}`;
    if (!groups.has(key)) {
      groups.set(key, []);
      orderedKeys.push(key);
    }
    groups.get(key)?.push(item);
  }

  const entries: AnalysisRenderableEntry[] = [];

  for (const key of orderedKeys) {
    const groupItems = [...(groups.get(key) ?? [])];
    if (groupItems.length === 0) {
      continue;
    }

    if (groupItems.length === 1) {
      entries.push({ kind: 'item', item: groupItems[0] });
      continue;
    }

    const ranked = [...groupItems].sort((left, right) => {
      const byScore = (right.analysisPresentation?.promotionScore ?? 0) - (left.analysisPresentation?.promotionScore ?? 0);
      if (byScore !== 0) {
        return byScore;
      }
      return sortFeedItemsByRecency(left, right);
    });
    const leadItem = ranked[0];
    const remainingItems = groupItems.filter((item) => item.id !== leadItem.id);

    entries.push({ kind: 'item', item: leadItem });

    if (remainingItems.length === 1) {
      entries.push({ kind: 'item', item: remainingItems[0] });
      continue;
    }

    if (remainingItems.length === 0) {
      continue;
    }

    const latestTimestamp = remainingItems.reduce((latest, item) => {
      const timestamp = getEntryTimestamp(item);
      return timestamp.localeCompare(latest) > 0 ? timestamp : latest;
    }, getEntryTimestamp(remainingItems[0]));

    entries.push({
      kind: 'series',
      key: `${key}:bundle`,
      title: buildSeriesTitle(leadItem),
      labels: remainingItems.map((item) => item.analysisPresentation?.conciseLabel ?? 'Analysis'),
      items: remainingItems,
      leadItem,
      latestTimestamp,
    });
  }

  return entries;
}

export function countRenderableAnalysisItems(entries: AnalysisRenderableEntry[]): number {
  return entries.reduce((count, entry) => (
    count + (entry.kind === 'item' ? 1 : entry.items.length)
  ), 0);
}

export function isFirstClassFeedItemType(type: FeedItemType): boolean {
  return type === 'tweet' || type === 'article' || type === 'analysis';
}
