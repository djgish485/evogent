import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { bulkInsertPreferences, type PreferenceInsert } from '@/lib/db/preferences';
import { regeneratePreferenceContext } from '@/lib/preferences-context';

const execFileAsync = promisify(execFile);

export interface ArchiveImportResult {
  interests: { found: number; imported: number };
  likes: { found: number; imported: number };
  tweets: { found: number; imported: number };
  following: { found: number; imported: number };
  bookmarks: { found: number; imported: number };
  blocks: { found: number; imported: number };
  mutes: { found: number; imported: number };
  total: { found: number; imported: number };
  elapsed: string;
}

const LIKE_BATCH_SIZE = 500;
const TWITTER_EPOCH = BigInt('1288834974657');
const TWITTER_SNOWFLAKE_SHIFT = BigInt(22);

interface InterestEntry {
  name?: unknown;
}

interface PersonalizationRecord {
  p13nData?: {
    interests?: {
      interests?: InterestEntry[];
    };
  };
}

interface LikeRecord {
  like?: {
    tweetId?: unknown;
    fullText?: unknown;
  };
}

interface TweetRecord {
  tweet?: {
    id_str?: unknown;
    full_text?: unknown;
  };
}

interface BlockRecord {
  blocking?: {
    accountId?: unknown;
    userLink?: unknown;
  };
}

interface MuteRecord {
  muting?: {
    accountId?: unknown;
    userLink?: unknown;
  };
}

interface FollowingRecord {
  following?: {
    accountId?: unknown;
    userLink?: unknown;
  };
}

interface BookmarkRecord {
  bookmark?: {
    tweetId?: unknown;
    fullText?: unknown;
  };
}

function asString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function tweetIdToDate(tweetId: string): string | undefined {
  try {
    const ts = Number((BigInt(tweetId) >> TWITTER_SNOWFLAKE_SHIFT) + TWITTER_EPOCH);
    if (ts > 0 && ts < Date.now() + 86_400_000) {
      return new Date(ts).toISOString().replace('T', ' ').slice(0, 19);
    }
  } catch {}
  return undefined;
}

function resolveDataDir(archivePath: string): string {
  const directDataPath = path.join(archivePath, 'data');
  if (fs.existsSync(directDataPath) && fs.statSync(directDataPath).isDirectory()) {
    return directDataPath;
  }

  if (path.basename(archivePath) === 'data' && fs.existsSync(archivePath)) {
    return archivePath;
  }

  try {
    const entries = fs.readdirSync(archivePath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(archivePath, entry.name, 'data');
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        return candidate;
      }
    }
  } catch {
    // Keep default below.
  }

  return directDataPath;
}

async function prepareArchiveInput(archivePath: string): Promise<{
  dataDir: string;
  cleanup: () => Promise<void>;
}> {
  const stats = await fs.promises.stat(archivePath);
  if (stats.isDirectory()) {
    return {
      dataDir: resolveDataDir(archivePath),
      cleanup: async () => {},
    };
  }

  if (!stats.isFile()) {
    throw new Error('Archive path must be a directory or .zip file');
  }

  const extension = path.extname(archivePath).toLowerCase();
  if (extension !== '.zip') {
    throw new Error('Archive file must be a .zip export');
  }

  const extractRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'evogent-twitter-archive-'));
  try {
    await execFileAsync('unzip', ['-o', '-q', archivePath, '-d', extractRoot]);
  } catch (error) {
    await fs.promises.rm(extractRoot, { recursive: true, force: true });
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to extract archive zip: ${message}`);
  }

  return {
    dataDir: resolveDataDir(extractRoot),
    cleanup: async () => {
      await fs.promises.rm(extractRoot, { recursive: true, force: true });
    },
  };
}

export function parseArchiveFile(filePath: string): unknown[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  const jsonStart = raw.indexOf('[');
  if (jsonStart === -1) {
    return [];
  }

  const jsonEnd = raw.lastIndexOf(']');
  const candidate = raw
    .slice(jsonStart, jsonEnd >= jsonStart ? jsonEnd + 1 : undefined)
    .trim();

  try {
    const parsed = JSON.parse(candidate);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[import-archive] Failed to parse ${filePath}: ${message}`);
    return [];
  }
}

function importInterests(dataDir: string): { found: number; imported: number } {
  const filePath = path.join(dataDir, 'personalization.js');
  if (!fs.existsSync(filePath)) {
    return { found: 0, imported: 0 };
  }

  const parsed = parseArchiveFile(filePath) as PersonalizationRecord[];
  const interests = parsed[0]?.p13nData?.interests?.interests ?? [];
  if (!Array.isArray(interests) || interests.length === 0) {
    return { found: 0, imported: 0 };
  }

  const inserts: PreferenceInsert[] = interests.flatMap((interest) => {
    const name = asString(interest?.name);
    if (!name) return [];

    return [{
      signalType: 'explicit',
      source: 'twitter_archive_interest',
      weight: 2.0,
      text: name,
      sourceId: `interest:${name}`,
    }];
  });

  return {
    found: interests.length,
    imported: bulkInsertPreferences(inserts),
  };
}

function importLikes(dataDir: string): { found: number; imported: number } {
  const filePath = path.join(dataDir, 'like.js');
  if (!fs.existsSync(filePath)) {
    return { found: 0, imported: 0 };
  }

  const parsed = parseArchiveFile(filePath) as LikeRecord[];
  if (parsed.length === 0) {
    return { found: 0, imported: 0 };
  }

  let imported = 0;
  for (let index = 0; index < parsed.length; index += LIKE_BATCH_SIZE) {
    const batch = parsed.slice(index, index + LIKE_BATCH_SIZE);
    const inserts: PreferenceInsert[] = batch.flatMap((row) => {
      const text = asString(row.like?.fullText);
      if (!text) return [];
      const tweetId = asString(row.like?.tweetId);

      return [{
        signalType: 'liked',
        source: 'twitter_archive_like',
        weight: 1.0,
        text,
        sourceId: tweetId ?? undefined,
        createdAt: tweetId ? tweetIdToDate(tweetId) : undefined,
      }];
    });

    imported += bulkInsertPreferences(inserts);
  }

  return {
    found: parsed.length,
    imported,
  };
}

function importTweets(dataDir: string): { found: number; imported: number } {
  const filePath = path.join(dataDir, 'tweets.js');
  if (!fs.existsSync(filePath)) {
    return { found: 0, imported: 0 };
  }

  const parsed = parseArchiveFile(filePath) as TweetRecord[];
  if (parsed.length === 0) {
    return { found: 0, imported: 0 };
  }

  const inserts: PreferenceInsert[] = parsed.flatMap((row) => {
    const text = asString(row.tweet?.full_text);
    if (!text) return [];
    const tweetId = asString(row.tweet?.id_str);

    return [{
      signalType: 'explicit',
      source: 'twitter_archive_tweet',
      weight: 0.8,
      text,
      sourceId: tweetId ?? undefined,
      createdAt: tweetId ? tweetIdToDate(tweetId) : undefined,
    }];
  });

  return {
    found: parsed.length,
    imported: bulkInsertPreferences(inserts),
  };
}

function importBlocks(dataDir: string): { found: number; imported: number } {
  const filePath = path.join(dataDir, 'block.js');
  if (!fs.existsSync(filePath)) {
    return { found: 0, imported: 0 };
  }

  const parsed = parseArchiveFile(filePath) as BlockRecord[];
  if (parsed.length === 0) {
    return { found: 0, imported: 0 };
  }

  const inserts: PreferenceInsert[] = parsed.flatMap((row) => {
    const userLink = asString(row.blocking?.userLink);
    if (!userLink) return [];

    return [{
      signalType: 'disliked',
      source: 'twitter_archive_block',
      weight: 2.0,
      text: `Blocked account: ${userLink}`,
      sourceId: asString(row.blocking?.accountId) ?? undefined,
    }];
  });

  return {
    found: parsed.length,
    imported: bulkInsertPreferences(inserts),
  };
}

function importMutes(dataDir: string): { found: number; imported: number } {
  const filePath = path.join(dataDir, 'mute.js');
  if (!fs.existsSync(filePath)) {
    return { found: 0, imported: 0 };
  }

  const parsed = parseArchiveFile(filePath) as MuteRecord[];
  if (parsed.length === 0) {
    return { found: 0, imported: 0 };
  }

  const inserts: PreferenceInsert[] = parsed.flatMap((row) => {
    const userLink = asString(row.muting?.userLink);
    if (!userLink) return [];

    return [{
      signalType: 'hidden',
      source: 'twitter_archive_mute',
      weight: 1.5,
      text: `Muted account: ${userLink}`,
      sourceId: asString(row.muting?.accountId) ?? undefined,
    }];
  });

  return {
    found: parsed.length,
    imported: bulkInsertPreferences(inserts),
  };
}

function importFollowing(dataDir: string): { found: number; imported: number } {
  const filePath = path.join(dataDir, 'following.js');
  if (!fs.existsSync(filePath)) {
    return { found: 0, imported: 0 };
  }

  const parsed = parseArchiveFile(filePath) as FollowingRecord[];
  if (parsed.length === 0) {
    return { found: 0, imported: 0 };
  }

  const inserts: PreferenceInsert[] = parsed.flatMap((row) => {
    const userLink = asString(row.following?.userLink);
    if (!userLink) return [];

    return [{
      signalType: 'explicit',
      source: 'twitter_archive_following',
      weight: 1.5,
      text: `Follows account: ${userLink}`,
      sourceId: asString(row.following?.accountId) ?? undefined,
    }];
  });

  return {
    found: parsed.length,
    imported: bulkInsertPreferences(inserts),
  };
}

function importBookmarks(dataDir: string): { found: number; imported: number } {
  const filePath = path.join(dataDir, 'bookmarks.js');
  if (!fs.existsSync(filePath)) {
    return { found: 0, imported: 0 };
  }

  const parsed = parseArchiveFile(filePath) as BookmarkRecord[];
  if (parsed.length === 0) {
    return { found: 0, imported: 0 };
  }

  const inserts: PreferenceInsert[] = parsed.flatMap((row) => {
    const tweetId = asString(row.bookmark?.tweetId);
    const text = asString(row.bookmark?.fullText) ?? (tweetId ? `Bookmarked tweet: ${tweetId}` : null);
    if (!text) return [];

    return [{
      signalType: 'liked',
      source: 'twitter_archive_bookmark',
      weight: 1.5,
      text,
      sourceId: tweetId ? `bookmark:${tweetId}` : undefined,
      createdAt: tweetId ? tweetIdToDate(tweetId) : undefined,
    }];
  });

  return {
    found: parsed.length,
    imported: bulkInsertPreferences(inserts),
  };
}

export async function importTwitterArchive(archivePath: string): Promise<ArchiveImportResult> {
  const startedAt = Date.now();
  const prepared = await prepareArchiveInput(archivePath);

  try {
    const interests = importInterests(prepared.dataDir);
    const likes = importLikes(prepared.dataDir);
    const tweets = importTweets(prepared.dataDir);
    const following = importFollowing(prepared.dataDir);
    const bookmarks = importBookmarks(prepared.dataDir);
    const blocks = importBlocks(prepared.dataDir);
    const mutes = importMutes(prepared.dataDir);

    try {
      await regeneratePreferenceContext();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[import-archive] Failed to regenerate preference context: ${message}`);
    }

    const totalFound = interests.found
      + likes.found
      + tweets.found
      + following.found
      + bookmarks.found
      + blocks.found
      + mutes.found;
    const totalImported = interests.imported
      + likes.imported
      + tweets.imported
      + following.imported
      + bookmarks.imported
      + blocks.imported
      + mutes.imported;

    return {
      interests,
      likes,
      tweets,
      following,
      bookmarks,
      blocks,
      mutes,
      total: {
        found: totalFound,
        imported: totalImported,
      },
      elapsed: `${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
    };
  } finally {
    await prepared.cleanup();
  }
}
