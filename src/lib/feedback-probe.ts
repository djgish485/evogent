import type { FeedbackProbeMetadata, FeedItem } from '@/types/feed';

export function normalizeFeedbackProbeMetadata(input: unknown): FeedbackProbeMetadata | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }

  const raw = input as Record<string, unknown>;
  const probe: FeedbackProbeMetadata = {};

  if (typeof raw.reason === 'string' && raw.reason.trim()) {
    probe.reason = raw.reason.trim();
  }
  if (typeof raw.uncertainty === 'string' && raw.uncertainty.trim()) {
    probe.uncertainty = raw.uncertainty.trim();
  }
  if (typeof raw.category === 'string' && raw.category.trim()) {
    probe.category = raw.category.trim();
  }
  if (raw.options && typeof raw.options === 'object' && !Array.isArray(raw.options)) {
    const optionsRaw = raw.options as Record<string, unknown>;
    const options: NonNullable<FeedbackProbeMetadata['options']> = {};
    if (typeof optionsRaw.moreLabel === 'string' && optionsRaw.moreLabel.trim()) {
      options.moreLabel = optionsRaw.moreLabel.trim();
    }
    if (typeof optionsRaw.lessLabel === 'string' && optionsRaw.lessLabel.trim()) {
      options.lessLabel = optionsRaw.lessLabel.trim();
    }
    if (typeof optionsRaw.positiveLabel === 'string' && optionsRaw.positiveLabel.trim()) {
      options.positiveLabel = optionsRaw.positiveLabel.trim();
    }
    if (typeof optionsRaw.negativeLabel === 'string' && optionsRaw.negativeLabel.trim()) {
      options.negativeLabel = optionsRaw.negativeLabel.trim();
    }
    if (Object.keys(options).length > 0) {
      probe.options = options;
    }
  }
  if (Array.isArray(raw.sourceItemIds)) {
    const sourceItemIds = raw.sourceItemIds
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (sourceItemIds.length > 0) {
      probe.sourceItemIds = Array.from(new Set(sourceItemIds));
    }
  }

  return Object.keys(probe).length > 0 ? probe : null;
}

export function getThreadFeedbackProbe(items: FeedItem[]): FeedbackProbeMetadata | null {
  for (const item of items) {
    const probe = normalizeFeedbackProbeMetadata(item.metadata?.feedbackProbe);
    if (probe) return probe;
  }
  return null;
}

export function getThreadSourceItemIds(items: FeedItem[], feedbackProbe: FeedbackProbeMetadata | null): string[] {
  const ids = feedbackProbe?.sourceItemIds && feedbackProbe.sourceItemIds.length > 0
    ? feedbackProbe.sourceItemIds
    : items.map((item) => item.id);
  return Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)));
}
