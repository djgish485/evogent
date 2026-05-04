'use client';

import { getPreferredFeedMediaItems, getMediaThumbnailUrl } from '@/lib/feed-media';
import type { AnalysisSeriesBundleEntry } from '@/lib/analysis-presentation';

interface AnalysisSeriesCardProps {
  entry: AnalysisSeriesBundleEntry;
  onOpenDetail?: (itemId: string) => void;
}

function formatRelativeTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  const diffMinutes = Math.floor((Date.now() - date.getTime()) / 60_000);
  if (diffMinutes < 1) return 'now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function AnalysisSeriesCard({
  entry,
  onOpenDetail,
}: AnalysisSeriesCardProps) {
  const heroMedia = getPreferredFeedMediaItems(entry.leadItem);
  const heroMediaUrl = heroMedia[0] ? getMediaThumbnailUrl(heroMedia[0]) : null;
  const heroSourceLabel = entry.leadItem.analysisPresentation?.heroMediaSource?.title?.trim()
    || entry.leadItem.analysisPresentation?.heroMediaSource?.authorDisplayName?.trim()
    || entry.leadItem.analysisPresentation?.heroMediaSource?.authorUsername?.trim()
    || null;
  const visibleLabels = entry.labels.slice(0, 4);
  const remainingCount = Math.max(0, entry.items.length - visibleLabels.length);

  return (
    <section
      data-testid="analysis-series-card"
      className="w-full overflow-hidden rounded-2xl border border-zinc-800/80 bg-zinc-950/90 shadow-[0_12px_36px_rgba(0,0,0,0.18)]"
    >
      {heroMediaUrl && (
        <div className="h-36 w-full overflow-hidden border-b border-zinc-800 bg-zinc-900">
          <img
            src={heroMediaUrl}
            alt=""
            className="h-full w-full object-cover"
          />
        </div>
      )}

      <div className="p-4">
        <div className="flex items-center gap-2 text-xs uppercase tracking-[0.16em] text-zinc-500">
          <span className="rounded-full border border-zinc-700 bg-black/30 px-2 py-1 text-[10px] font-medium text-zinc-300">
            Analysis series
          </span>
          <span>{formatRelativeTimestamp(entry.latestTimestamp)}</span>
        </div>

        <div className="mt-3">
          <h3 className="text-[17px] font-semibold leading-snug text-zinc-100">{entry.title}</h3>
          <p className="mt-1 text-sm text-zinc-400">
            {entry.items.length} related {entry.items.length === 1 ? 'analysis' : 'analyses'}
            {heroSourceLabel ? ` synthesizing ${heroSourceLabel}` : ''}
          </p>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {visibleLabels.map((label, index) => {
            const item = entry.items[index];
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onOpenDetail?.(item.id)}
                className="rounded-full border border-zinc-700 bg-black/25 px-3 py-1.5 text-left text-sm text-zinc-200 transition-colors hover:border-zinc-500 hover:bg-zinc-900"
              >
                {label}
              </button>
            );
          })}
          {remainingCount > 0 && (
            <span className="rounded-full border border-zinc-700/80 bg-zinc-900/70 px-3 py-1.5 text-sm text-zinc-400">
              +{remainingCount} more
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
