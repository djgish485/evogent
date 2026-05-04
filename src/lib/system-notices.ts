import type { FeedItem } from '@/types/feed';

function normalizeNoticeText(value: string | null | undefined): string {
  return (value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

export function isLowValueReflectionSummary(item: FeedItem): boolean {
  if (item.type !== 'analysis' || item.metadata?.reflectionCycle !== true) {
    return false;
  }

  const title = normalizeNoticeText(item.title);
  const text = normalizeNoticeText(item.text);

  const mentionsReflectionCompletion = text.includes('reflection complete');
  const saysNoMeaningfulChange = (
    text.includes('no new patterns detected')
    || text.includes('current insights remain accurate')
    || text.includes('nothing meaningful changed')
  );

  return title === 'reflection: what i learned'
    && mentionsReflectionCompletion
    && saysNoMeaningfulChange;
}

export function isOperationalSetupProgressNotice(item: FeedItem): boolean {
  if (item.type !== 'notification') {
    return false;
  }

  const title = normalizeNoticeText(item.title);
  const text = normalizeNoticeText(item.text);
  const sourceId = normalizeNoticeText(item.sourceId);
  const notificationId = normalizeNoticeText(
    typeof item.metadata?.notificationId === 'string' ? item.metadata.notificationId : '',
  );
  const severity = normalizeNoticeText(
    typeof item.metadata?.severity === 'string' ? item.metadata.severity : '',
  );
  const combined = `${title} ${text} ${sourceId} ${notificationId}`;

  if (severity === 'error' || severity === 'critical') {
    return false;
  }

  if (/\b(required|failed|failure|blocked|missing provider|provider unavailable)\b/.test(combined)) {
    return false;
  }

  const isSetupProgress = combined.includes('setup in progress')
    || combined.includes('setup-progress')
    || combined.includes('setup progress');
  const isFeedPoolStatus = combined.includes('feed pool')
    || combined.includes('first curation')
    || combined.includes('curation found 0')
    || combined.includes('0 items curated');

  return isSetupProgress && isFeedPoolStatus;
}

export function shouldSuppressFeedSystemNotice(item: FeedItem): boolean {
  return isLowValueReflectionSummary(item)
    || isOperationalSetupProgressNotice(item);
}
