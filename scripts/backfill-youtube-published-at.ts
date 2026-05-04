import Database from 'better-sqlite3';
import { pathToFileURL } from 'node:url';
import { getDefaultDbPath } from '../src/lib/data-dir';

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const FUTURE_SKEW_TOLERANCE_MS = 5 * MINUTE_MS;

const monthIndexes = new Map([
  ['jan', 0],
  ['january', 0],
  ['feb', 1],
  ['february', 1],
  ['mar', 2],
  ['march', 2],
  ['apr', 3],
  ['april', 3],
  ['may', 4],
  ['jun', 5],
  ['june', 5],
  ['jul', 6],
  ['july', 6],
  ['aug', 7],
  ['august', 7],
  ['sep', 8],
  ['sept', 8],
  ['september', 8],
  ['oct', 9],
  ['october', 9],
  ['nov', 10],
  ['november', 10],
  ['dec', 11],
  ['december', 11],
]);

interface YoutubeCacheRow {
  source_id: string;
  payload_json: string;
  fetched_at_ms: number;
}

interface ParseOptions {
  referenceMs: number;
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function subtractCalendarUnits(referenceMs: number, unit: 'month' | 'year', amount: number): number {
  const referenceDate = new Date(referenceMs);
  const year = referenceDate.getUTCFullYear();
  const month = referenceDate.getUTCMonth();
  const day = referenceDate.getUTCDate();
  const hour = referenceDate.getUTCHours();
  const minute = referenceDate.getUTCMinutes();
  const second = referenceDate.getUTCSeconds();
  const millisecond = referenceDate.getUTCMilliseconds();

  if (unit === 'year') {
    const targetYear = year - amount;
    const targetDay = Math.min(day, daysInMonth(targetYear, month));
    return Date.UTC(targetYear, month, targetDay, hour, minute, second, millisecond);
  }

  const targetMonthOffset = month - amount;
  const targetYear = year + Math.floor(targetMonthOffset / 12);
  const targetMonth = ((targetMonthOffset % 12) + 12) % 12;
  const targetDay = Math.min(day, daysInMonth(targetYear, targetMonth));
  return Date.UTC(targetYear, targetMonth, targetDay, hour, minute, second, millisecond);
}

function isAcceptableTimestamp(timestampMs: number, referenceMs: number): boolean {
  return Number.isFinite(timestampMs)
    && timestampMs >= 0
    && timestampMs <= referenceMs + FUTURE_SKEW_TOLERANCE_MS;
}

function relativeAmount(value: string): number | null {
  const normalized = value.toLowerCase();
  if (normalized === 'a' || normalized === 'an' || normalized === 'one') {
    return 1;
  }

  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseRelativePublishedAtMs(label: string, referenceMs: number): number | null {
  if (/\bjust now\b/i.test(label)) {
    return referenceMs;
  }

  const match = label.match(/\b(a|an|one|\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago\b/i);
  if (!match) {
    return null;
  }

  const amount = relativeAmount(match[1] ?? '');
  if (amount === null) {
    return null;
  }

  const unit = (match[2] ?? '').toLowerCase();
  if (unit === 'second') return referenceMs - amount * SECOND_MS;
  if (unit === 'minute') return referenceMs - amount * MINUTE_MS;
  if (unit === 'hour') return referenceMs - amount * HOUR_MS;
  if (unit === 'day') return referenceMs - amount * DAY_MS;
  if (unit === 'week') return referenceMs - amount * WEEK_MS;
  if (unit === 'month') return subtractCalendarUnits(referenceMs, 'month', amount);
  if (unit === 'year') return subtractCalendarUnits(referenceMs, 'year', amount);

  return null;
}

function parseIsoDatePublishedAtMs(label: string, referenceMs: number): number | null {
  const match = label.match(/\b(\d{4})-(\d{2})-(\d{2})(?:[T\s][0-9:.+-Z]+)?\b/);
  if (!match) {
    return null;
  }

  const timestampMs = match[0].includes('T')
    ? Date.parse(match[0])
    : Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));

  return isAcceptableTimestamp(timestampMs, referenceMs) ? timestampMs : null;
}

function parseMonthDatePublishedAtMs(label: string, referenceMs: number): number | null {
  const match = label.match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?\b/i);
  if (!match) {
    return null;
  }

  const monthIndex = monthIndexes.get((match[1] ?? '').toLowerCase().replace('.', ''));
  const day = Number.parseInt(match[2] ?? '', 10);
  const referenceDate = new Date(referenceMs);
  const explicitYear = match[3] ? Number.parseInt(match[3], 10) : null;
  let year = explicitYear ?? referenceDate.getUTCFullYear();

  if (monthIndex === undefined || !Number.isInteger(day) || day < 1 || day > daysInMonth(year, monthIndex)) {
    return null;
  }

  let timestampMs = Date.UTC(year, monthIndex, day);
  if (explicitYear === null && timestampMs > referenceMs + FUTURE_SKEW_TOLERANCE_MS) {
    year -= 1;
    if (day > daysInMonth(year, monthIndex)) {
      return null;
    }
    timestampMs = Date.UTC(year, monthIndex, day);
  }

  return isAcceptableTimestamp(timestampMs, referenceMs) ? timestampMs : null;
}

export function parseYoutubePublishedAtMs(label: string | null | undefined, options: ParseOptions): number | null {
  const normalized = typeof label === 'string'
    ? label.trim().replace(/\s+/g, ' ')
    : '';
  if (!normalized || !Number.isFinite(options.referenceMs)) {
    return null;
  }

  const relativeMs = parseRelativePublishedAtMs(normalized, options.referenceMs);
  if (relativeMs !== null && isAcceptableTimestamp(relativeMs, options.referenceMs)) {
    return relativeMs;
  }

  return parseIsoDatePublishedAtMs(normalized, options.referenceMs)
    ?? parseMonthDatePublishedAtMs(normalized, options.referenceMs);
}

function readPublishLabels(payloadJson: string): string[] {
  try {
    const payload = JSON.parse(payloadJson) as { publishLabel?: unknown; publishDateText?: unknown };
    return [payload.publishLabel, payload.publishDateText]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .filter((value, index, labels) => labels.indexOf(value) === index);
  } catch {
    return [];
  }
}

function parseRowPublishedAtMs(row: YoutubeCacheRow): number | null {
  for (const label of readPublishLabels(row.payload_json)) {
    const publishedAtMs = parseYoutubePublishedAtMs(label, { referenceMs: row.fetched_at_ms });
    if (publishedAtMs !== null) {
      return publishedAtMs;
    }
  }

  return null;
}

export function backfillYoutubePublishedAt(dbPath = process.env.MEDIA_AGENT_DB_PATH || getDefaultDbPath()): {
  totalNull: number;
  parsed: number;
  unparseable: number;
} {
  const db = new Database(dbPath);

  try {
    const rows = db.prepare(`
      SELECT source_id, payload_json, fetched_at_ms
      FROM browse_cache_items
      WHERE source = 'youtube'
        AND published_at_ms IS NULL
    `).all() as YoutubeCacheRow[];

    const updatePublishedAt = db.prepare(`
      UPDATE browse_cache_items
      SET published_at_ms = ?
      WHERE source = 'youtube'
        AND source_id = ?
        AND published_at_ms IS NULL
    `);

    let parsed = 0;
    const updateRows = db.transaction((items: YoutubeCacheRow[]) => {
      for (const row of items) {
        const publishedAtMs = parseRowPublishedAtMs(row);
        if (publishedAtMs === null) {
          continue;
        }

        parsed += updatePublishedAt.run(publishedAtMs, row.source_id).changes;
      }
    });

    updateRows(rows);

    return {
      totalNull: rows.length,
      parsed,
      unparseable: rows.length - parsed,
    };
  } finally {
    db.close();
  }
}

function main(): void {
  const counts = backfillYoutubePublishedAt();
  console.log(`[backfill-youtube-published-at] Total NULL: ${counts.totalNull}`);
  console.log(`[backfill-youtube-published-at] Parsed: ${counts.parsed}`);
  console.log(`[backfill-youtube-published-at] Unparseable: ${counts.unparseable}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(`[backfill-youtube-published-at] fatal error: ${message}`);
    process.exitCode = 1;
  }
}
