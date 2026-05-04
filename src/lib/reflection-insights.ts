import fs from 'node:fs';
import { getDataPath } from '@/lib/data-dir';

export const DEFAULT_REFLECTION_HOURS = 168;
const MAX_REFLECTION_HOURS = 24 * 365;

const curationCandidatesPath = getDataPath('curation-candidates.jsonl');
const SOURCE_TEXT_COMPLETENESS_BUCKET = 'source text incomplete/recovery';

const REJECTION_REASON_BUCKET_PATTERNS: Array<{ bucket: string; patterns: RegExp[] }> = [
  {
    bucket: SOURCE_TEXT_COMPLETENESS_BUCKET,
    patterns: [
      /\bsource[-_ ]incomplete[-_ ]text\b/,
      /\bincomplete[-_ ]source\b/,
      /\bcached timeline text\b.*\btruncated\b/,
      /\btext[-_ ]completeness\b/,
      /\bstatus[-_ ]page recovery\b/,
      /\brecovery failed\b/,
      /\bvisibly truncated\b/,
      /\bclipped\b/,
    ],
  },
  {
    bucket: 'already covered/duplicate',
    patterns: [
      /\balready\b/,
      /\bduplicate\b/,
      /\bduplicative\b/,
      /\bcovered\b/,
      /\bredundan(?:t|cy)\b/,
      /\brepeat(?:ed|ing)?\b/,
      /\boverlap(?:ping)?\b/,
      /\bsame angle\b/,
      /\balready in (?:the )?feed\b/,
    ],
  },
  {
    bucket: 'low-signal/quality bar',
    patterns: [
      /\blow[- ]signal\b/,
      /\blow engagement\b/,
      /\bweak substance\b/,
      /\bthin\b/,
      /\bshallow\b/,
      /\bone[- ]liner\b/,
      /\blink[- ]only\b/,
      /\bnot enough substance\b/,
      /\bnot much there\b/,
      /\bquality bar\b/,
      /\blittle detail\b/,
      /\bfiller\b/,
      /\bbanter\b/,
      /\breactive commentary\b/,
      /\bno concrete\b/,
    ],
  },
  {
    bucket: 'event-only reporting',
    patterns: [
      /\bevent\b/,
      /\breporting\b/,
      /\bheadline\b/,
      /\bbreaking update\b/,
      /\bnews peg\b/,
      /\bjust reporting\b/,
      /\bno analysis\b/,
      /\bno mechanism\b/,
      /\bno clear thesis\b/,
    ],
  },
  {
    bucket: 'topic fit/boundary',
    patterns: [
      /\boff[- ]topic\b/,
      /\birrelevant\b/,
      /\boutside (?:the )?(?:current )?topic boundaries\b/,
      /\btopic boundaries\b/,
      /\bcurrent curation brief\b/,
      /\btangential\b/,
      /\bout of scope\b/,
      /\bnot aligned\b/,
      /\bweak tie\b/,
      /\bnot (?:a )?fit\b/,
      /\boutside (?:the )?brief\b/,
      /\badjacent\b/,
    ],
  },
  {
    bucket: 'evidence gap/speculative',
    patterns: [
      /\bneeds? (?:better|more) evidence\b/,
      /\bspeculative\b/,
      /\bunclear\b/,
      /\bnot confirmed\b/,
      /\bweak sourcing\b/,
      /\bunverified\b/,
      /\brumou?r\b/,
      /\bpremature\b/,
      /\btoo early to tell\b/,
      /\bincomplete reporting\b/,
    ],
  },
  {
    bucket: 'novelty/timing',
    patterns: [
      /\bstale\b/,
      /\btoo old\b/,
      /\boutdated\b/,
      /\bnot new\b/,
      /\bolder version\b/,
      /\btiming\b/,
      /\bfreshness\b/,
      /\bold news\b/,
      /\bnot timely\b/,
      /\bno new (?:development|information|insight)\b/,
      /\bincremental follow[- ]up\b/,
      /\bnovelty\b/,
    ],
  },
  {
    bucket: 'source quality/noise',
    patterns: [
      /\bclickbait\b/,
      /\brage[- ]bait\b/,
      /\bmeme\b/,
      /\baggregator\b/,
      /\blow trust\b/,
      /\bdubious\b/,
      /\bspam\b/,
      /\bpromotional\b/,
      /\bmarketing\b/,
      /\bhype thread\b/,
      /\bengagement bait\b/,
      /\blow credibility\b/,
    ],
  },
];

type RejectionCandidateEntry = {
  cycleId: string;
  sourceId: string;
  authorUsername: string | null;
  text: string;
  reason: string;
  rejectionReason: string;
  timestamp: string;
  metadata: Record<string, unknown> | null;
};

type RejectionCycleSummary = {
  type: 'cycle_summary';
  cycleId: string;
  timestamp: string;
};

export type RejectionScorecard = {
  cycleCount: number;
  totalRejected: number;
  topRejectedAuthors: Array<{ username: string; count: number }>;
  rejectionReasonCategories: Record<string, number>;
  sourceQualityMisses: number;
  almostRelevant: Array<{
    sourceId: string;
    authorUsername: string | null;
    text: string;
    reason: string;
    rejectionReason: string;
  }>;
  hoursQueried: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseTrimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseTimestampMs(value: unknown): number | null {
  const timestamp = parseTrimmedString(value);
  if (!timestamp) return null;

  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}

function createEmptyScorecard(hoursQueried: number): RejectionScorecard {
  return {
    cycleCount: 0,
    totalRejected: 0,
    topRejectedAuthors: [],
    rejectionReasonCategories: {},
    sourceQualityMisses: 0,
    almostRelevant: [],
    hoursQueried,
  };
}

function countPatternMatches(text: string, patterns: RegExp[]) {
  let matches = 0;
  for (const pattern of patterns) {
    if (pattern.test(text)) {
      matches += 1;
    }
  }
  return matches;
}

export function categorizeRejectionReason(reason: string, context: string | null = null): string {
  const normalized = [reason, context]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' ')
    .toLowerCase();

  let bestBucket = 'unclear/other';
  let bestScore = 0;

  for (const candidate of REJECTION_REASON_BUCKET_PATTERNS) {
    const score = countPatternMatches(normalized, candidate.patterns);
    if (score > bestScore) {
      bestBucket = candidate.bucket;
      bestScore = score;
    }
  }

  return bestBucket;
}

function parseCandidateEntry(value: unknown): RejectionCandidateEntry | null {
  if (!isRecord(value)) return null;

  const cycleId = parseTrimmedString(value.cycleId);
  const sourceId = parseTrimmedString(value.sourceId);
  const text = parseTrimmedString(value.text);
  const reason = parseTrimmedString(value.reason);
  const rejectionReason = parseTrimmedString(value.rejectionReason);
  const timestamp = parseTrimmedString(value.timestamp);

  if (!cycleId || !sourceId || !text || !reason || !rejectionReason || !timestamp) {
    return null;
  }

  return {
    cycleId,
    sourceId,
    authorUsername: parseTrimmedString(value.authorUsername),
    text,
    reason,
    rejectionReason,
    timestamp,
    metadata: isRecord(value.metadata) ? value.metadata : null,
  };
}

function parseCycleSummary(value: unknown): RejectionCycleSummary | null {
  if (!isRecord(value) || value.type !== 'cycle_summary') return null;

  const cycleId = parseTrimmedString(value.cycleId);
  const timestamp = parseTrimmedString(value.timestamp);
  if (!cycleId || !timestamp) return null;

  return {
    type: 'cycle_summary',
    cycleId,
    timestamp,
  };
}

function readNestedString(input: Record<string, unknown> | null, path: string[]): string | null {
  let current: unknown = input;
  for (const segment of path) {
    current = isRecord(current) ? current[segment] : null;
  }
  return parseTrimmedString(current);
}

function isSourceTextCompletenessMiss(entry: RejectionCandidateEntry, category: string): boolean {
  if (category === SOURCE_TEXT_COMPLETENESS_BUCKET) {
    return true;
  }

  const metadata = entry.metadata;
  const rejectionScope = parseTrimmedString(metadata?.rejectionScope)?.toLowerCase();
  const sourceQualityIssue = parseTrimmedString(metadata?.sourceQualityIssue)?.toLowerCase()
    ?? readNestedString(metadata, ['sourceQuality', 'issue'])?.toLowerCase();

  return rejectionScope === 'source_quality'
    && typeof sourceQualityIssue === 'string'
    && /\b(?:text|completeness|incomplete|truncated|clipped)\b/.test(sourceQualityIssue);
}

export function normalizeReflectionHours(input: string | null | undefined): number {
  const parsed = Number.parseInt(input ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_REFLECTION_HOURS;
  }

  return Math.max(1, Math.min(MAX_REFLECTION_HOURS, Math.floor(parsed)));
}

export async function getRejectionScorecard(
  hoursQueried: number,
  options: { filePath?: string; now?: number } = {},
): Promise<RejectionScorecard> {
  const safeHours = Math.max(1, Math.min(MAX_REFLECTION_HOURS, Math.floor(hoursQueried)));
  const filePath = options.filePath ?? curationCandidatesPath;
  const now = options.now ?? Date.now();
  const cutoff = now - safeHours * 60 * 60 * 1000;

  let fileContents = '';
  try {
    fileContents = await fs.promises.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return createEmptyScorecard(safeHours);
    }
    throw error;
  }

  const cycleIds = new Set<string>();
  const authorCounts = new Map<string, number>();
  const categoryCounts = new Map<string, number>();
  const almostRelevant: Array<RejectionScorecard['almostRelevant'][number] & { timestampMs: number; category: string }> = [];
  let totalRejected = 0;
  let sourceQualityMisses = 0;

  for (const rawLine of fileContents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    const cycleSummary = parseCycleSummary(parsed);
    if (cycleSummary) {
      const timestampMs = parseTimestampMs(cycleSummary.timestamp);
      if (timestampMs !== null && timestampMs >= cutoff) {
        cycleIds.add(cycleSummary.cycleId);
      }
      continue;
    }

    const entry = parseCandidateEntry(parsed);
    if (!entry) continue;

    const timestampMs = parseTimestampMs(entry.timestamp);
    if (timestampMs === null || timestampMs < cutoff) {
      continue;
    }

    totalRejected += 1;

    const category = categorizeRejectionReason(entry.rejectionReason, entry.reason);
    const sourceTextCompletenessMiss = isSourceTextCompletenessMiss(entry, category);
    if (sourceTextCompletenessMiss) {
      sourceQualityMisses += 1;
    }

    if (entry.authorUsername && !sourceTextCompletenessMiss) {
      authorCounts.set(entry.authorUsername, (authorCounts.get(entry.authorUsername) ?? 0) + 1);
    }

    categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);

    if (
      entry.rejectionReason.length > 50
      && !sourceTextCompletenessMiss
      && category !== 'already covered/duplicate'
      && category !== 'low-signal/quality bar'
      && category !== 'source quality/noise'
    ) {
      almostRelevant.push({
        sourceId: entry.sourceId,
        authorUsername: entry.authorUsername,
        text: entry.text,
        reason: entry.reason,
        rejectionReason: entry.rejectionReason,
        timestampMs,
        category,
      });
    }
  }

  return {
    cycleCount: cycleIds.size,
    totalRejected,
    topRejectedAuthors: [...authorCounts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 10)
      .map(([username, count]) => ({ username, count })),
    rejectionReasonCategories: Object.fromEntries(
      [...categoryCounts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])),
    ),
    sourceQualityMisses,
    almostRelevant: almostRelevant
      .sort((left, right) => right.timestampMs - left.timestampMs)
      .slice(0, 10)
      .map((entry) => ({
        sourceId: entry.sourceId,
        authorUsername: entry.authorUsername,
        text: entry.text,
        reason: entry.reason,
        rejectionReason: entry.rejectionReason,
      })),
    hoursQueried: safeHours,
  };
}
