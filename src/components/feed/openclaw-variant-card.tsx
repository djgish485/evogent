'use client';

import { FeedMarkdown, FEED_MARKDOWN_COMPACT_BODY_CLASS_NAME, FEED_MARKDOWN_TIGHT_BODY_CLASS_NAME, HighlightedSearchText } from '@/components/feed/feed-markdown';
import { formatCompactTimestamp, getFeedItemCompactTimestampSource } from '@/lib/compact-timestamp';
import { isProminentFeedItem } from '@/lib/feed-prominence';
import type { FeedItem } from '@/types/feed';

const OPENCLAW_VARIANTS = [
  'morning-brief',
  'email-digest',
  'pr-review',
  'calendar-event',
  'health-rollup',
  'decision-record',
  'smart-home',
  'package-delivered',
  'weather-alert',
  'bill-paid',
  'deep-work-suggestion',
  'lab-results',
  'competitor-watch',
  'quiet-checkin',
] as const;

export type OpenClawCardVariant = typeof OPENCLAW_VARIANTS[number];

type OpenClawVariantConfig = {
  label: string;
  icon: IconName;
  cardClassName: string;
  iconClassName: string;
  railClassName: string;
  chipClassName: string;
};

type IconName =
  | 'bell'
  | 'brief'
  | 'calendar'
  | 'check'
  | 'cloud'
  | 'code'
  | 'eye'
  | 'heart'
  | 'home'
  | 'lab'
  | 'lightbulb'
  | 'mail'
  | 'package'
  | 'receipt';

interface OpenClawVariantCardProps {
  item: FeedItem;
  variant: OpenClawCardVariant;
  onOpenDetail?: (item: FeedItem) => void;
  searchQuery?: string | null;
  pendingNotificationAction?: 'dismiss' | null;
  notificationFeedback?: string | null;
  onNotificationDismiss?: (item: FeedItem) => void;
}

const variantConfigs: Record<OpenClawCardVariant, OpenClawVariantConfig> = {
  'morning-brief': {
    label: 'Morning brief',
    icon: 'brief',
    cardClassName: 'border-cyan-700/50 bg-cyan-950/[0.11]',
    iconClassName: 'border-cyan-500/50 bg-cyan-500/15 text-cyan-100',
    railClassName: 'bg-cyan-300',
    chipClassName: 'border-cyan-500/45 bg-cyan-500/10 text-cyan-100',
  },
  'email-digest': {
    label: 'Email digest',
    icon: 'mail',
    cardClassName: 'border-sky-700/50 bg-sky-950/[0.10]',
    iconClassName: 'border-sky-500/50 bg-sky-500/15 text-sky-100',
    railClassName: 'bg-sky-300',
    chipClassName: 'border-sky-500/45 bg-sky-500/10 text-sky-100',
  },
  'pr-review': {
    label: 'PR review',
    icon: 'code',
    cardClassName: 'border-emerald-700/50 bg-emerald-950/[0.10]',
    iconClassName: 'border-emerald-500/50 bg-emerald-500/15 text-emerald-100',
    railClassName: 'bg-emerald-300',
    chipClassName: 'border-emerald-500/45 bg-emerald-500/10 text-emerald-100',
  },
  'calendar-event': {
    label: 'Calendar event',
    icon: 'calendar',
    cardClassName: 'border-indigo-700/45 bg-indigo-950/[0.10]',
    iconClassName: 'border-indigo-500/50 bg-indigo-500/15 text-indigo-100',
    railClassName: 'bg-indigo-300',
    chipClassName: 'border-indigo-500/45 bg-indigo-500/10 text-indigo-100',
  },
  'health-rollup': {
    label: 'Health rollup',
    icon: 'heart',
    cardClassName: 'border-rose-700/45 bg-rose-950/[0.10]',
    iconClassName: 'border-rose-500/50 bg-rose-500/15 text-rose-100',
    railClassName: 'bg-rose-300',
    chipClassName: 'border-rose-500/45 bg-rose-500/10 text-rose-100',
  },
  'decision-record': {
    label: 'Decision record',
    icon: 'check',
    cardClassName: 'border-teal-700/45 bg-teal-950/[0.10]',
    iconClassName: 'border-teal-500/50 bg-teal-500/15 text-teal-100',
    railClassName: 'bg-teal-300',
    chipClassName: 'border-teal-500/45 bg-teal-500/10 text-teal-100',
  },
  'smart-home': {
    label: 'Smart home',
    icon: 'home',
    cardClassName: 'border-lime-700/40 bg-lime-950/[0.10]',
    iconClassName: 'border-lime-500/45 bg-lime-500/15 text-lime-100',
    railClassName: 'bg-lime-300',
    chipClassName: 'border-lime-500/40 bg-lime-500/10 text-lime-100',
  },
  'package-delivered': {
    label: 'Package delivered',
    icon: 'package',
    cardClassName: 'border-amber-700/45 bg-amber-950/[0.10]',
    iconClassName: 'border-amber-500/50 bg-amber-500/15 text-amber-100',
    railClassName: 'bg-amber-300',
    chipClassName: 'border-amber-500/45 bg-amber-500/10 text-amber-100',
  },
  'weather-alert': {
    label: 'Weather alert',
    icon: 'cloud',
    cardClassName: 'border-blue-700/45 bg-blue-950/[0.10]',
    iconClassName: 'border-blue-500/50 bg-blue-500/15 text-blue-100',
    railClassName: 'bg-blue-300',
    chipClassName: 'border-blue-500/45 bg-blue-500/10 text-blue-100',
  },
  'bill-paid': {
    label: 'Bill paid',
    icon: 'receipt',
    cardClassName: 'border-green-700/45 bg-green-950/[0.10]',
    iconClassName: 'border-green-500/50 bg-green-500/15 text-green-100',
    railClassName: 'bg-green-300',
    chipClassName: 'border-green-500/45 bg-green-500/10 text-green-100',
  },
  'deep-work-suggestion': {
    label: 'Deep work',
    icon: 'lightbulb',
    cardClassName: 'border-fuchsia-700/40 bg-fuchsia-950/[0.09]',
    iconClassName: 'border-fuchsia-500/45 bg-fuchsia-500/15 text-fuchsia-100',
    railClassName: 'bg-fuchsia-300',
    chipClassName: 'border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-100',
  },
  'lab-results': {
    label: 'Lab results',
    icon: 'lab',
    cardClassName: 'border-pink-700/40 bg-pink-950/[0.09]',
    iconClassName: 'border-pink-500/45 bg-pink-500/15 text-pink-100',
    railClassName: 'bg-pink-300',
    chipClassName: 'border-pink-500/40 bg-pink-500/10 text-pink-100',
  },
  'competitor-watch': {
    label: 'Competitor watch',
    icon: 'eye',
    cardClassName: 'border-orange-700/45 bg-orange-950/[0.10]',
    iconClassName: 'border-orange-500/50 bg-orange-500/15 text-orange-100',
    railClassName: 'bg-orange-300',
    chipClassName: 'border-orange-500/45 bg-orange-500/10 text-orange-100',
  },
  'quiet-checkin': {
    label: 'Quiet check-in',
    icon: 'bell',
    cardClassName: 'border-zinc-700/70 bg-zinc-950/90',
    iconClassName: 'border-zinc-600/70 bg-zinc-800/70 text-zinc-100',
    railClassName: 'bg-zinc-400',
    chipClassName: 'border-zinc-600/80 bg-zinc-900/80 text-zinc-200',
  },
};

const knownVariants = new Set<string>(OPENCLAW_VARIANTS);

export function resolveOpenClawCardVariant(item: FeedItem): OpenClawCardVariant | null {
  const metadataVariant = typeof item.metadata?.cardVariant === 'string'
    ? item.metadata.cardVariant.trim()
    : '';

  if (knownVariants.has(metadataVariant)) {
    return metadataVariant as OpenClawCardVariant;
  }

  if (!item.id.startsWith('openclaw-demo-')) {
    return null;
  }

  const inferredVariant = item.id.slice('openclaw-demo-'.length);
  if (knownVariants.has(inferredVariant)) {
    return inferredVariant as OpenClawCardVariant;
  }

  return null;
}

function OpenClawMark() {
  return (
    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-cyan-400/45 bg-cyan-500/12 text-[11px] font-black tracking-[0.12em] text-cyan-100 shadow-[0_0_24px_rgba(34,211,238,0.12)]">
      OC
    </div>
  );
}

function Icon({ name, className = 'h-5 w-5' }: { name: IconName; className?: string }) {
  const baseProps = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className,
    'aria-hidden': true,
  };

  switch (name) {
    case 'bell':
      return <svg {...baseProps}><path d="M18 8a6 6 0 0 0-12 0c0 7-3 6-3 8h18c0-2-3-1-3-8" /><path d="M10 20a2 2 0 0 0 4 0" /></svg>;
    case 'brief':
      return <svg {...baseProps}><path d="M4 7h16v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7Z" /><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M8 12h8" /></svg>;
    case 'calendar':
      return <svg {...baseProps}><path d="M8 2v4" /><path d="M16 2v4" /><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M3 10h18" /><path d="M8 14h.01" /><path d="M12 14h.01" /><path d="M16 14h.01" /></svg>;
    case 'check':
      return <svg {...baseProps}><path d="M20 6 9 17l-5-5" /></svg>;
    case 'cloud':
      return <svg {...baseProps}><path d="M16 13a4 4 0 0 0-7.9-.9A3.5 3.5 0 1 0 7.5 19H16a3 3 0 0 0 0-6Z" /><path d="M8 21v-2" /><path d="M12 21v-2" /><path d="M16 21v-2" /></svg>;
    case 'code':
      return <svg {...baseProps}><path d="m16 18 6-6-6-6" /><path d="m8 6-6 6 6 6" /><path d="m14 4-4 16" /></svg>;
    case 'eye':
      return <svg {...baseProps}><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></svg>;
    case 'heart':
      return <svg {...baseProps}><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8Z" /></svg>;
    case 'home':
      return <svg {...baseProps}><path d="m3 11 9-8 9 8" /><path d="M5 10v10h14V10" /><path d="M9 20v-6h6v6" /></svg>;
    case 'lab':
      return <svg {...baseProps}><path d="M10 2v6l-5.5 9.5A3 3 0 0 0 7.1 22h9.8a3 3 0 0 0 2.6-4.5L14 8V2" /><path d="M8 2h8" /><path d="M7 16h10" /></svg>;
    case 'lightbulb':
      return <svg {...baseProps}><path d="M9 18h6" /><path d="M10 22h4" /><path d="M12 2a7 7 0 0 0-4 12.7c.6.4 1 1.1 1 1.8V17h6v-.5c0-.7.4-1.4 1-1.8A7 7 0 0 0 12 2Z" /></svg>;
    case 'mail':
      return <svg {...baseProps}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></svg>;
    case 'package':
      return <svg {...baseProps}><path d="m21 8-9-5-9 5 9 5 9-5Z" /><path d="M3 8v8l9 5 9-5V8" /><path d="M12 13v8" /></svg>;
    case 'receipt':
      return <svg {...baseProps}><path d="M6 2h12v20l-3-2-3 2-3-2-3 2V2Z" /><path d="M9 7h6" /><path d="M9 11h6" /><path d="M9 15h4" /></svg>;
  }
}

function stripMarkdown(value: string): string {
  return value
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .trim();
}

function firstTextLine(text: string): string {
  return stripMarkdown(text)
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) ?? '';
}

function listItems(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+\S/.test(line))
    .map((line) => line.replace(/^[-*]\s+(?:\[[ xX]\]\s+)?/, '').trim())
    .filter(Boolean);
}

function emailRows(text: string): Array<{ sender: string; subject: string; summary: string }> {
  return listItems(text).map((line) => {
    const clean = stripMarkdown(line);
    const senderMatch = clean.match(/^([^:—–-]{2,48})\s*[:—–-]\s*(.+)$/);
    const sender = senderMatch?.[1]?.trim() || 'Priority';
    const rest = senderMatch?.[2]?.trim() || clean;
    const subjectMatch = rest.match(/^(?:subject\s*)?([^:—–-]{2,80})\s*[:—–-]\s*(.+)$/i);

    return {
      sender,
      subject: subjectMatch?.[1]?.trim() || rest,
      summary: subjectMatch?.[2]?.trim() || '',
    };
  });
}

function statValue(text: string, labelPattern: RegExp): string | null {
  const match = text.match(labelPattern);
  return match?.[1]?.trim() ?? null;
}

function VariantMarkdown({ text, searchQuery }: { text: string; searchQuery?: string | null }) {
  return (
    <FeedMarkdown
      text={text}
      searchQuery={searchQuery}
      className={FEED_MARKDOWN_COMPACT_BODY_CLASS_NAME}
    />
  );
}

function renderEmailDigest(item: FeedItem, searchQuery?: string | null) {
  const rows = emailRows(item.text).slice(0, 5);
  if (rows.length < 2) {
    return <VariantMarkdown text={item.text} searchQuery={searchQuery} />;
  }

  return (
    <div className="mt-4 overflow-hidden rounded-xl border border-white/10 bg-black/20">
      <div className="grid grid-cols-[0.9fr_1.2fr_1.4fr] gap-3 border-b border-white/10 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
        <span>Sender</span>
        <span>Subject</span>
        <span>Why it matters</span>
      </div>
      {rows.map((row, index) => (
        <div key={`${row.sender}:${index}`} className="grid gap-2 border-b border-white/8 px-3 py-2 text-sm last:border-b-0 sm:grid-cols-[0.9fr_1.2fr_1.4fr]">
          <p className="font-semibold text-zinc-100">{row.sender}</p>
          <p className="text-zinc-200">{row.subject}</p>
          <p className="text-zinc-400">{row.summary || 'Needs a pass today.'}</p>
        </div>
      ))}
    </div>
  );
}

function renderPrReview(item: FeedItem, searchQuery?: string | null) {
  const suggestions = listItems(item.text).slice(0, 4);
  if (suggestions.length === 0) {
    return <VariantMarkdown text={item.text} searchQuery={searchQuery} />;
  }

  return (
    <div className="mt-4 space-y-2">
      {suggestions.map((suggestion, index) => (
        <div key={`${suggestion}:${index}`} className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.06] px-3 py-2">
          <span className="mt-1 flex h-5 w-5 items-center justify-center rounded-full border border-emerald-400/40 text-emerald-200">
            <Icon name="check" className="h-3.5 w-3.5" />
          </span>
          <FeedMarkdown
            text={suggestion}
            searchQuery={searchQuery}
            className={FEED_MARKDOWN_TIGHT_BODY_CLASS_NAME}
          />
        </div>
      ))}
    </div>
  );
}

function renderHealthRollup(item: FeedItem, searchQuery?: string | null) {
  const text = stripMarkdown(item.text);
  const stats = [
    { label: 'Sleep', value: statValue(text, /\bsleep\b[^0-9a-z]*(\d+(?:\.\d+)?\s*(?:h|hr|hrs|hours?))/i) ?? 'Logged' },
    { label: 'HRV', value: statValue(text, /\bhrv\b[^0-9]*(\d+\s*ms)/i) ?? 'Tracked' },
    { label: 'Recovery', value: statValue(text, /\brecovery\b[^0-9a-z]*(\d+%|[a-z]+(?:\s+[a-z]+)?)/i) ?? 'Review' },
  ];

  return (
    <div className="mt-4 space-y-4">
      <div className="grid grid-cols-3 gap-2">
        {stats.map((stat) => (
          <div key={stat.label} className="rounded-xl border border-rose-400/20 bg-rose-400/[0.06] px-3 py-2">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-rose-200/70">{stat.label}</p>
            <p className="mt-1 text-sm font-semibold text-zinc-100">{stat.value}</p>
          </div>
        ))}
      </div>
      <VariantMarkdown text={item.text} searchQuery={searchQuery} />
    </div>
  );
}

function renderCompactSignal(item: FeedItem, config: OpenClawVariantConfig, searchQuery?: string | null) {
  return (
    <div className="mt-4 flex items-start gap-3 rounded-xl border border-white/10 bg-black/18 px-3 py-3">
      <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border ${config.iconClassName}`}>
        <Icon name={config.icon} className="h-5 w-5" />
      </div>
      <FeedMarkdown
        text={item.text}
        searchQuery={searchQuery}
        className={FEED_MARKDOWN_TIGHT_BODY_CLASS_NAME}
      />
    </div>
  );
}

function renderCalendarEvent(item: FeedItem, config: OpenClawVariantConfig, searchQuery?: string | null) {
  const summary = firstTextLine(item.text) || item.title || 'Calendar event';
  return (
    <div className="mt-4 grid gap-3 rounded-xl border border-indigo-400/20 bg-indigo-400/[0.06] px-3 py-3 sm:grid-cols-[5rem_minmax(0,1fr)]">
      <div className="flex flex-col items-center justify-center rounded-lg border border-indigo-400/25 bg-black/20 px-2 py-2 text-center">
        <Icon name={config.icon} className="h-5 w-5 text-indigo-100" />
        <span className="mt-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-indigo-200/70">Today</span>
      </div>
      <div>
        <p className="text-sm font-semibold text-zinc-100">{summary}</p>
        <div className="mt-2">
          <VariantMarkdown text={item.text} searchQuery={searchQuery} />
        </div>
      </div>
    </div>
  );
}

function renderDecisionRecord(item: FeedItem, searchQuery?: string | null) {
  const decisions = listItems(item.text).slice(0, 3);
  return (
    <div className="mt-4 space-y-3">
      <div className="rounded-xl border border-teal-400/20 bg-teal-400/[0.06] px-3 py-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-teal-200/70">Recorded decision</p>
        <p className="mt-1 text-sm font-semibold text-zinc-100">{firstTextLine(item.text) || item.title || 'Decision saved'}</p>
      </div>
      {decisions.length > 0 ? (
        <div className="space-y-1.5">
          {decisions.map((decision, index) => (
            <FeedMarkdown
              key={`${decision}:${index}`}
              text={decision}
              searchQuery={searchQuery}
              className={FEED_MARKDOWN_TIGHT_BODY_CLASS_NAME}
            />
          ))}
        </div>
      ) : (
        <VariantMarkdown text={item.text} searchQuery={searchQuery} />
      )}
    </div>
  );
}

function renderCompetitorWatch(item: FeedItem, searchQuery?: string | null) {
  const bullets = listItems(item.text).slice(0, 4);
  if (bullets.length === 0) {
    return <VariantMarkdown text={item.text} searchQuery={searchQuery} />;
  }

  return (
    <div className="mt-4 space-y-2">
      {bullets.map((bullet, index) => (
        <div key={`${bullet}:${index}`} className="flex gap-2 rounded-xl border border-orange-400/20 bg-orange-400/[0.06] px-3 py-2">
          <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-orange-300" />
          <FeedMarkdown
            text={bullet}
            searchQuery={searchQuery}
            className={FEED_MARKDOWN_TIGHT_BODY_CLASS_NAME}
          />
        </div>
      ))}
    </div>
  );
}

function renderDeepWork(item: FeedItem, config: OpenClawVariantConfig, searchQuery?: string | null) {
  return (
    <div className="mt-4 rounded-xl border border-fuchsia-400/20 bg-fuchsia-400/[0.06] px-4 py-3">
      <div className="flex items-center gap-2">
        <span className={`flex h-8 w-8 items-center justify-center rounded-lg border ${config.iconClassName}`}>
          <Icon name={config.icon} className="h-4 w-4" />
        </span>
        <p className="text-sm font-semibold text-zinc-100">{firstTextLine(item.text) || 'Protected focus block'}</p>
      </div>
      <div className="mt-3">
        <VariantMarkdown text={item.text} searchQuery={searchQuery} />
      </div>
    </div>
  );
}

function renderVariantBody(
  item: FeedItem,
  variant: OpenClawCardVariant,
  config: OpenClawVariantConfig,
  searchQuery?: string | null,
) {
  switch (variant) {
    case 'email-digest':
      return renderEmailDigest(item, searchQuery);
    case 'pr-review':
      return renderPrReview(item, searchQuery);
    case 'health-rollup':
      return renderHealthRollup(item, searchQuery);
    case 'calendar-event':
      return renderCalendarEvent(item, config, searchQuery);
    case 'decision-record':
      return renderDecisionRecord(item, searchQuery);
    case 'competitor-watch':
      return renderCompetitorWatch(item, searchQuery);
    case 'deep-work-suggestion':
      return renderDeepWork(item, config, searchQuery);
    case 'smart-home':
    case 'package-delivered':
    case 'weather-alert':
    case 'bill-paid':
    case 'lab-results':
    case 'quiet-checkin':
      return renderCompactSignal(item, config, searchQuery);
    case 'morning-brief':
      return (
        <div className="mt-5">
          <VariantMarkdown text={item.text} searchQuery={searchQuery} />
        </div>
      );
  }
}

export function OpenClawVariantCard({
  item,
  variant,
  onOpenDetail,
  searchQuery = null,
  pendingNotificationAction = null,
  notificationFeedback = null,
  onNotificationDismiss,
}: OpenClawVariantCardProps) {
  const config = variantConfigs[variant];
  const timestamp = getFeedItemCompactTimestampSource(item);
  const timestampLabel = formatCompactTimestamp(timestamp);
  const isLead = variant === 'morning-brief' || isProminentFeedItem(item);
  const canOpenDetail = Boolean(onOpenDetail) && item.type !== 'notification' && item.type !== 'suggestion';
  const dismissable = item.type === 'notification' && item.metadata?.dismissable !== false && onNotificationDismiss;

  return (
    <article
      data-testid="openclaw-variant-card"
      data-openclaw-variant={variant}
      data-item-type={item.type}
      data-item-id={item.id}
      data-feed-item-id={item.id}
      data-feed-item-type={item.type}
      data-prominence={item.metadata?.prominence?.level}
      role={canOpenDetail ? 'link' : undefined}
      tabIndex={canOpenDetail ? 0 : undefined}
      className={`group relative w-full overflow-hidden rounded-2xl border px-4 py-4 shadow-[0_12px_36px_rgba(0,0,0,0.18)] transition-[background-color,border-color,box-shadow] hover:border-zinc-600/80 hover:bg-zinc-950 hover:shadow-[0_18px_44px_rgba(0,0,0,0.24)] ${canOpenDetail ? 'cursor-pointer' : ''} ${config.cardClassName} ${isLead ? 'sm:px-5 sm:py-5' : ''}`}
      onClick={() => {
        if (canOpenDetail) {
          onOpenDetail?.(item);
        }
      }}
      onKeyDown={(event) => {
        if (!canOpenDetail) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpenDetail?.(item);
        }
      }}
    >
      <span className={`pointer-events-none absolute bottom-4 left-0 top-4 w-[3px] rounded-r-full ${config.railClassName}`} aria-hidden="true" />
      <div className="relative pl-2 sm:pl-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <OpenClawMark />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${config.chipClassName}`}>
                  <Icon name={config.icon} className="h-3.5 w-3.5" />
                  OpenClaw
                </span>
                <span className="rounded-full border border-zinc-700/70 bg-black/25 px-2 py-0.5 text-[11px] font-medium text-zinc-300">
                  {config.label}
                </span>
                {timestampLabel ? (
                  <time dateTime={timestamp ?? undefined} className="text-[11px] text-zinc-500">
                    {timestampLabel}
                  </time>
                ) : null}
              </div>
              <h3 className={`mt-2 font-semibold leading-tight text-zinc-50 ${isLead ? 'text-[24px] sm:text-[30px]' : 'text-[17px] sm:text-[18px]'}`}>
                <HighlightedSearchText text={item.title?.trim() || config.label} searchQuery={searchQuery} />
              </h3>
            </div>
          </div>

          {dismissable ? (
            <button
              type="button"
              data-testid="openclaw-notification-dismiss-button"
              disabled={pendingNotificationAction !== null}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onNotificationDismiss?.(item);
              }}
              aria-label="Dismiss notification"
              className="rounded-md border border-zinc-700 bg-black/20 px-2 py-1 text-xs text-zinc-300 transition-colors hover:bg-black/35 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {pendingNotificationAction === 'dismiss' ? '...' : 'X'}
            </button>
          ) : null}
        </div>

        {renderVariantBody(item, variant, config, searchQuery)}

        {notificationFeedback ? (
          <p className={`mt-3 text-xs ${notificationFeedback.toLowerCase().includes('failed') ? 'text-red-300' : 'text-zinc-400'}`}>
            {notificationFeedback}
          </p>
        ) : null}
      </div>
    </article>
  );
}
