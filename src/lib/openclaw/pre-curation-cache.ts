import { getInternalBaseUrl } from '@/lib/internal-api';

export const OPENCLAW_PRE_CURATION_CACHE_REFRESH_TIMEOUT_MS = 4 * 60 * 1000;

type FetchImpl = typeof fetch;

type PreCurationCacheRefreshResponse = {
  ok?: boolean;
  error?: string;
  skipped?: boolean;
  reason?: string;
  timedOut?: boolean;
  pendingSources?: string[];
  sourceResults?: Array<{
    source?: string;
    result?: string | null;
    status?: string | null;
    error?: string | null;
  }>;
};

export function isFullOpenClawCurationRequest(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized || normalized.includes('latest-content-focused')) return false;
  return normalized === '/curate'
    || /^run (?:a full|one evogent) curation cycle\b/.test(normalized);
}

export function buildOpenClawPreCurationCacheRefreshPayload(message: string, requestId: string | null) {
  return {
    waitForCompletion: true,
    timeoutMs: OPENCLAW_PRE_CURATION_CACHE_REFRESH_TIMEOUT_MS,
    task: {
      id: requestId || `openclaw-curation-${Date.now()}`,
      priority: 'heartbeat',
      message,
      metadata: {
        automatedCuration: true,
        curationCommand: '/curate',
      },
    },
  };
}

export async function refreshCachesBeforeOpenClawCuration(
  message: string,
  requestId: string | null,
  options: {
    fetchImpl?: FetchImpl;
    getBaseUrl?: () => string;
  } = {},
): Promise<void> {
  if (!isFullOpenClawCurationRequest(message)) {
    return;
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const getBaseUrl = options.getBaseUrl ?? getInternalBaseUrl;

  const response = await fetchImpl(`${getBaseUrl()}/api/internal/cache-refresh/pre-curation`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    cache: 'no-store',
    body: JSON.stringify(buildOpenClawPreCurationCacheRefreshPayload(message, requestId)),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`pre-curation cache refresh trigger failed (${response.status})${body ? `: ${body}` : ''}`);
  }
  const payload = await response.json().catch(() => null) as PreCurationCacheRefreshResponse | null;
  if (payload?.ok === false) {
    throw new Error(payload.error || 'pre-curation cache refresh trigger failed');
  }
  if (payload?.skipped) {
    return;
  }
  if (payload?.timedOut) {
    const pending = Array.isArray(payload.pendingSources) && payload.pendingSources.length > 0
      ? ` Pending sources: ${payload.pendingSources.join(', ')}.`
      : '';
    throw new Error(`pre-curation cache refresh timed out before full curation.${pending}`);
  }
  const incompleteSources = Array.isArray(payload?.sourceResults)
    ? payload.sourceResults.filter((sourceResult) => (
      sourceResult?.result === 'enqueue_failed'
      || sourceResult?.result === 'failed'
      || sourceResult?.result === 'no_run_recorded'
    ))
    : [];
  if (incompleteSources.length > 0) {
    const detail = incompleteSources
      .map((sourceResult) => {
        const source = sourceResult.source || 'unknown';
        const result = sourceResult.result || sourceResult.status || 'incomplete';
        const error = sourceResult.error ? ` (${sourceResult.error})` : '';
        return `${source}:${result}${error}`;
      })
      .join(', ');
    throw new Error(`pre-curation cache refresh did not complete cleanly: ${detail}`);
  }
}
