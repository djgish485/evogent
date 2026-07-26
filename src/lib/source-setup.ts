import fs from 'node:fs';
import path from 'node:path';
import type { FeedItem } from '@/types/feed';

const phoneSourcesDir = path.join(process.cwd(), 'data', 'phone-sources');

/**
 * Cancel an auto-added phone source while preserving reversible source changes: dismissing a source_setup
 * announcement card deletes the source's browse recipe and pending discovery queue entry,
 * and appends it to data/phone-sources/.optout so the scout never re-adds it and any
 * in-flight discovery aborts at its next checkpoint. Best-effort: the feed dismissal
 * itself must succeed even if the filesystem cleanup cannot.
 */
export function cancelSourceSetup(item: FeedItem): { cancelled: boolean; source: string | null } {
  const source = typeof item.metadata?.sourceName === 'string' ? item.metadata.sourceName.trim() : '';
  const pkg = typeof item.metadata?.sourcePackage === 'string' ? item.metadata.sourcePackage.trim() : '';
  if (!source || !/^[a-z0-9-]+$/.test(source)) {
    return { cancelled: false, source: null };
  }
  try {
    fs.mkdirSync(path.join(phoneSourcesDir, '.queue'), { recursive: true });
    for (const relative of [`${source}.txt`, `${source}.py`, path.join('.queue', `${source}.json`)]) {
      fs.rmSync(path.join(phoneSourcesDir, relative), { force: true });
    }
    fs.appendFileSync(path.join(phoneSourcesDir, '.optout'), `${source} ${pkg}\n`.trimStart());
    return { cancelled: true, source };
  } catch {
    return { cancelled: false, source };
  }
}
