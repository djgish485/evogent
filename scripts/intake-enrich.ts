import { pathToFileURL } from 'node:url';
import {
  listTopLevelItemsWithIncompleteEnrichment,
  resolveFeedItemByIdentifier,
} from '../src/lib/db/feed';
import {
  applyCachedItemEnrichment,
  itemIsStillIncomplete,
  queueFeedItemEnrichment,
  shouldAutoQueueFeedItemEnrichment,
} from '../src/lib/feed-enrichment';
import type { FeedItem } from '../src/types/feed';

interface ProcessResult {
  status: 'queued' | 'skipped' | 'failed';
  id: string;
  detail: string;
}

function serializeMetrics(item: FeedItem) {
  return JSON.stringify(item.metrics);
}

function serializeMetadata(item: FeedItem) {
  return JSON.stringify(item.metadata ?? null);
}

function describeCachePatch(before: FeedItem, after: FeedItem) {
  const changed = before.authorAvatarUrl !== after.authorAvatarUrl
    || JSON.stringify(before.mediaUrls) !== JSON.stringify(after.mediaUrls)
    || serializeMetrics(before) !== serializeMetrics(after)
    || serializeMetadata(before) !== serializeMetadata(after);

  return changed ? 'cached metadata copied' : 'no cached metadata changes';
}

export function parseArgs(argv: string[]): { id?: string } {
  let id: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--id') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('Missing value for --id');
      }
      id = value;
      index += 1;
      continue;
    }

    if (arg.startsWith('--id=')) {
      id = arg.slice('--id='.length);
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (id !== undefined) {
    const trimmed = id.trim();
    if (!trimmed) {
      throw new Error('--id cannot be empty');
    }
    return { id: trimmed };
  }

  return {};
}

export function resolveBatchTargets(limit = 30): FeedItem[] {
  return listTopLevelItemsWithIncompleteEnrichment(limit * 3)
    .filter((item) => shouldAutoQueueFeedItemEnrichment(item) && itemIsStillIncomplete(item))
    .slice(0, limit);
}

export async function processItem(
  item: FeedItem,
  queueEnrichment = queueFeedItemEnrichment,
): Promise<ProcessResult> {
  const patched = applyCachedItemEnrichment(item) ?? item;
  const cacheDetail = describeCachePatch(item, patched);

  if (!shouldAutoQueueFeedItemEnrichment(patched)) {
    return {
      status: 'skipped',
      id: item.id,
      detail: 'not a top-level enrichment candidate',
    };
  }

  if (!itemIsStillIncomplete(patched)) {
    return {
      status: 'skipped',
      id: item.id,
      detail: cacheDetail === 'cached metadata copied'
        ? `${cacheDetail}; enrichment no longer needed`
        : 'enrichment no longer needed',
    };
  }

  const result = await queueEnrichment(patched, {
    endpoint: 'scripts/intake-enrich.ts',
    mode: 'lightweight',
    routeId: patched.id,
    source: 'post_enrichment',
    trigger: 'intake_enrichment_batch',
  });

  if (!result.ok) {
    return {
      status: 'failed',
      id: item.id,
      detail: result.error ?? 'Failed to queue enrichment',
    };
  }

  return {
    status: 'queued',
    id: item.id,
    detail: cacheDetail === 'cached metadata copied'
      ? `${cacheDetail}; queued agent enrichment`
      : 'queued agent enrichment',
  };
}

async function main(): Promise<void> {
  const start = Date.now();
  const { id } = parseArgs(process.argv.slice(2));
  const targets = id
    ? (() => {
        const item = resolveFeedItemByIdentifier(id);
        if (!item) {
          throw new Error(`Feed item not found for identifier: ${id}`);
        }
        return [item];
      })()
    : resolveBatchTargets();

  console.log(`[intake-enrich] loaded ${targets.length} candidate feed items`);

  let queued = 0;
  let skipped = 0;
  let failed = 0;

  for (const item of targets) {
    const result = await processItem(item);
    if (result.status === 'queued') {
      queued += 1;
      console.log(`[intake-enrich] queued ${result.id}: ${result.detail}`);
      continue;
    }

    if (result.status === 'failed') {
      failed += 1;
      console.error(`[intake-enrich] failed ${result.id}: ${result.detail}`);
      continue;
    }

    skipped += 1;
    console.log(`[intake-enrich] skipped ${result.id}: ${result.detail}`);
  }

  const elapsedMs = Date.now() - start;
  console.log(`[intake-enrich] complete in ${elapsedMs}ms (queued=${queued}, skipped=${skipped}, failed=${failed})`);

  if (failed > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(`[intake-enrich] fatal error: ${message}`);
    process.exitCode = 1;
  });
}
