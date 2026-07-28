import { createHash } from 'node:crypto';
import {
  PHONE_BENCHMARK_SHARE_REFRESH_TRIGGERED_BY,
  type UpsertBrowseCacheItemInput,
} from './db/browse-cache';

const BENCHMARK_SHARE_KIND = 'full_browse_share';
const BENCHMARK_SHARE_MAX_ARM_AGE_MS = 2 * 60 * 1000;
const BENCHMARK_RUN_ID = /^full-browse-[A-Za-z0-9][A-Za-z0-9._:-]{7,140}$/;
const SHA256_DIGEST = /^[a-f0-9]{64}$/;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Benchmark share receipts are a narrow authenticated protocol, not generic caller metadata.
 * Validate the receipt against the one cache item before the DB transaction persists either.
 * Ordinary phone shares and every other browse-cache producer retain the existing path.
 */
export function validateBenchmarkSharePayload(
  payload: Record<string, unknown>,
  items: UpsertBrowseCacheItemInput[],
): void {
  if (payload.triggeredBy !== PHONE_BENCHMARK_SHARE_REFRESH_TRIGGERED_BY) return;

  const metadata = isRecord(payload.metadata) ? payload.metadata : null;
  const proof = metadata && isRecord(metadata.benchmarkShareProof)
    ? metadata.benchmarkShareProof
    : null;
  const item = items.length === 1 && isRecord(items[0]) ? items[0] : null;
  if (!metadata || !proof || !item) {
    throw new Error('Invalid benchmark share receipt');
  }

  const expectedMetadataKeys = ['benchmarkShareProof'];
  const expectedProofKeys = [
    'armedAtMs',
    'benchmarkRunId',
    'fetchedAtMs',
    'kind',
    'receiptId',
    'schemaVersion',
    'sequence',
    'sourceIdDigest',
    'tokenDigest',
  ];
  if (
    Object.keys(metadata).sort().join('\n') !== expectedMetadataKeys.join('\n')
    || Object.keys(proof).sort().join('\n') !== expectedProofKeys.join('\n')
    || payload.cycleSummary !== undefined
  ) {
    throw new Error('Invalid benchmark share receipt shape');
  }

  const benchmarkRunId = proof.benchmarkRunId;
  const sequence = proof.sequence;
  const receiptId = proof.receiptId;
  const tokenDigest = proof.tokenDigest;
  const sourceIdDigest = proof.sourceIdDigest;
  const armedAtMs = proof.armedAtMs;
  const fetchedAtMs = proof.fetchedAtMs;
  const sourceId = typeof item.sourceId === 'string' ? item.sourceId : '';
  const canonicalUrl = `https://www.youtube.com/watch?v=${sourceId}`;
  if (
    proof.schemaVersion !== 1
    || proof.kind !== BENCHMARK_SHARE_KIND
    || typeof benchmarkRunId !== 'string'
    || !BENCHMARK_RUN_ID.test(benchmarkRunId)
    || !isInteger(sequence)
    || sequence < 1
    || sequence > 5
    || typeof receiptId !== 'string'
    || typeof tokenDigest !== 'string'
    || !SHA256_DIGEST.test(tokenDigest)
    || receiptId !== `benchmark-share-${tokenDigest}`
    || payload.runId !== receiptId
    || typeof sourceIdDigest !== 'string'
    || !SHA256_DIGEST.test(sourceIdDigest)
    || !VIDEO_ID.test(sourceId)
    || sourceIdDigest !== sha256(sourceId)
    || !isInteger(armedAtMs)
    || !isInteger(fetchedAtMs)
    || armedAtMs <= 0
    || fetchedAtMs < armedAtMs
    || fetchedAtMs - armedAtMs > BENCHMARK_SHARE_MAX_ARM_AGE_MS
    || payload.source !== 'youtube'
    || payload.status !== 'completed'
    || payload.itemsAdded !== 1
    || payload.error !== undefined
    || payload.startedAtMs !== fetchedAtMs
    || payload.completedAtMs !== fetchedAtMs
    || (item.source !== undefined && item.source !== 'youtube')
    || item.fetchedAtMs !== fetchedAtMs
    || !isInteger(item.expiresAtMs)
    || item.expiresAtMs <= fetchedAtMs
    || item.url !== canonicalUrl
    || typeof item.title !== 'string'
    || item.title.trim().length <= 5
  ) {
    throw new Error('Invalid benchmark share receipt fields');
  }
}
