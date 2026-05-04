import type { FeedMetadata, FeedItemType } from '@/types/feed';

const CURATION_TIME_EVIDENCE_WINDOW_MS = 5 * 60 * 1000;
const TIMESTAMP_MATCH_TOLERANCE_MS = 1000;

type ArticlePublishValidationInput = {
  type: FeedItemType;
  source?: string | null;
  url?: string | null;
  publishedAt: string;
  metadata?: FeedMetadata | null;
  nowMs?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function trimString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseTimestampMs(value: unknown): number | null {
  const raw = trimString(value);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function readEvidenceStatus(value: unknown): 'verified' | 'unavailable' | 'uncertain' | null {
  const normalized = trimString(value)?.toLowerCase();
  if (!normalized) return null;
  if (['verified', 'source', 'source_metadata'].includes(normalized)) return 'verified';
  if (['unavailable', 'missing', 'not_found'].includes(normalized)) return 'unavailable';
  if (['uncertain', 'ambiguous'].includes(normalized)) return 'uncertain';
  return null;
}

function readSourcePublishTimeMs(metadata: FeedMetadata | null | undefined): number | null {
  const publishEvidence = isRecord(metadata?.publishEvidence) ? metadata.publishEvidence : null;
  if (publishEvidence) {
    return parseTimestampMs(publishEvidence.publishedAt)
      ?? parseTimestampMs(publishEvidence.datePublished)
      ?? parseTimestampMs(publishEvidence.articlePublishedTime)
      ?? parseTimestampMs(publishEvidence.value);
  }
  const article = isRecord(metadata?.article) ? metadata.article : null;
  if (article) {
    return parseTimestampMs(article.datePublished)
      ?? parseTimestampMs(article.publishedTime)
      ?? parseTimestampMs(article.articlePublishedTime)
      ?? parseTimestampMs(article.publishedAt);
  }
  return parseTimestampMs(metadata?.datePublished)
    ?? parseTimestampMs(metadata?.articlePublishedTime);
}

function isExcludedArticleSource(source?: string | null): boolean {
  return ['youtube', 'hackernews', 'hacker-news', 'hn'].includes(source?.trim().toLowerCase() ?? '');
}

function isNormalWebArticle(input: ArticlePublishValidationInput): boolean {
  if (input.type !== 'article') return false;
  if (isExcludedArticleSource(input.source)) return false;
  const url = trimString(input.url);
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function validateArticlePublishEvidence(input: ArticlePublishValidationInput): string | null {
  if (!isNormalWebArticle(input)) return null;
  const publishedAtMs = Date.parse(input.publishedAt);
  if (!Number.isFinite(publishedAtMs)) return null;
  const sourcePublishTimeMs = readSourcePublishTimeMs(input.metadata);
  if (sourcePublishTimeMs !== null) {
    if (Math.abs(sourcePublishTimeMs - publishedAtMs) > TIMESTAMP_MATCH_TOLERANCE_MS) {
      return 'Article publishedAt must match source-owned publish metadata when datePublished/article:published_time evidence is present.';
    }
    return null;
  }
  const publishEvidence = isRecord(input.metadata?.publishEvidence) ? input.metadata.publishEvidence : null;
  const evidenceStatus = readEvidenceStatus(publishEvidence?.status);
  if (evidenceStatus === 'verified') {
    return 'Verified article publish evidence must include a parseable source publishedAt/datePublished timestamp.';
  }
  if (evidenceStatus === 'unavailable' || evidenceStatus === 'uncertain') return null;
  const nowMs = input.nowMs ?? Date.now();
  if (Math.abs(nowMs - publishedAtMs) <= CURATION_TIME_EVIDENCE_WINDOW_MS) {
    return 'Direct web article publishedAt looks like submit time; include metadata.publishEvidence with source datePublished/article:published_time, or mark it unavailable/uncertain.';
  }
  return null;
}
