import fs from 'node:fs';
import path from 'node:path';
import type { FeedItem } from '@/types/feed';
import { getDataDir } from '@/lib/data-dir';
import { cancelBrowseCacheSource } from '@/lib/db/browse-cache';
import {
  getFeedItemBySourceId,
  setFeedItemSuggestionStatus,
} from '@/lib/db/feed';

/**
 * Cancel an auto-added phone source while preserving reversible source changes: dismissing a source_setup
 * announcement card deletes the source's browse recipe and pending discovery queue entry,
 * and appends it to data/phone-sources/.optout so the scout never re-adds it and any
 * in-flight discovery aborts at its next checkpoint. The database tombstone is
 * authoritative; filesystem cleanup after it is best-effort and model-free.
 */
export function cancelSourceSetup(item: FeedItem): { cancelled: boolean; source: string | null } {
  const source = typeof item.metadata?.sourceName === 'string' ? item.metadata.sourceName.trim() : '';
  const pkg = typeof item.metadata?.sourcePackage === 'string' ? item.metadata.sourcePackage.trim() : '';
  if (
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(source)
    || !/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(pkg)
  ) {
    return { cancelled: false, source: null };
  }
  try {
    // Commit the SQLite tombstone first. Activation checks it in the same database transaction,
    // so a late discovery submit/activation cannot resurrect evidence even if filesystem cleanup
    // fails or races the provider.
    cancelBrowseCacheSource(source);
  } catch {
    return { cancelled: false, source };
  }

  try {
    const phoneSourcesDir = path.join(getDataDir(), 'phone-sources');
    fs.mkdirSync(phoneSourcesDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(phoneSourcesDir, '.queue'), { recursive: true, mode: 0o700 });
    const optoutPath = path.join(phoneSourcesDir, '.optout');
    let alreadyOptedOut = false;
    try {
      const metadata = fs.lstatSync(optoutPath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error('Source opt-out ledger is not a regular file');
      }
      alreadyOptedOut = fs.readFileSync(optoutPath, 'utf8')
        .split(/\r?\n/)
        .some((line) => line.trim().split(/\s+/, 1)[0] === source);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw error;
      }
    }
    if (!alreadyOptedOut) {
      fs.appendFileSync(optoutPath, `${source} ${pkg}\n`, { encoding: 'utf8', mode: 0o600 });
    }
    const optoutFd = fs.openSync(optoutPath, 'r');
    try {
      fs.fsyncSync(optoutFd);
    } finally {
      fs.closeSync(optoutFd);
    }
    const directoryFd = fs.openSync(phoneSourcesDir, 'r');
    try {
      fs.fsyncSync(directoryFd);
    } finally {
      fs.closeSync(directoryFd);
    }

    for (const relative of [
      `${source}.txt`,
      `${source}.py`,
      path.join('.active', `${source}.json`),
      path.join('.queue', `${source}.json`),
      path.join('.queue', `discovery-v2-${source}.json`),
      path.join('.queue', `discovery-v3-${source}.json`),
    ]) {
      fs.rmSync(path.join(phoneSourcesDir, relative), { force: true });
    }
    const successNotice = getFeedItemBySourceId(`source-discovery-${source}`);
    if (successNotice?.type === 'notification') {
      setFeedItemSuggestionStatus(successNotice.id, 'dismissed');
    }
  } catch {
    // The durable database tombstone remains authoritative. The worker and installer can retry
    // filesystem cleanup model-free; do not turn a cleanup problem into permission to reactivate.
  }
  return { cancelled: true, source };
}
