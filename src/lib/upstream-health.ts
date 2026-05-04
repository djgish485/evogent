import {
  getSharedBrowserCdpUrl,
  probeSharedBrowserSession,
  probeSharedBrowserTwitterAuth,
  probeSharedBrowserVersion,
  type SharedBrowserProbeResult,
  type SharedBrowserSessionProbeResult,
} from '@/lib/shared-browser';
import { listInstalledSkills } from '@/lib/skills';

const KNOWN_SOURCES = ['twitter', 'youtube', 'substack', 'hackernews'] as const;
const SHARED_BROWSER_SOURCES = new Set(['twitter', 'youtube', 'substack']);
const SHARED_BROWSER_PROVIDER_ID = 'shared_browser';

type BrowseSource = (typeof KNOWN_SOURCES)[number];
type IncidentScope = 'none' | 'provider' | 'source';
type DependencyStatus = 'unused' | 'healthy' | 'degraded';
type RecommendedActionKind = 'none' | 'notification' | 'code_fix';

export type BrowseFailureKind =
  | 'none'
  | 'auth'
  | 'rate_limited'
  | 'source_regression'
  | 'provider_hung';

export interface SharedBrowserConsumer {
  source: BrowseSource;
  reason: string;
}

export interface SharedBrowserRunEvidence {
  source: BrowseSource;
  id: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  callsAttempted: number;
  error: string | null;
  rawEvidence: null;
}

export interface BrowseDependencyHealth {
  id: string;
  label: string;
  status: DependencyStatus;
  detail: string | null;
  consumers: SharedBrowserConsumer[];
  liveProbe: SharedBrowserProbeResult | null;
  sessionProbe: SharedBrowserSessionProbeResult | null;
  explicitFailureCount: number;
  explicitFailures: SharedBrowserRunEvidence[];
  maskedRunCount: number;
  maskedRuns: SharedBrowserRunEvidence[];
}

export interface BrowseIncidentTargetState {
  incidentKey: string | null;
  active: boolean;
  itemId: string | null;
  sourceId: string | null;
}

export interface BrowseIncidentRouting {
  scope: IncidentScope;
  key: string | null;
  dependencyId: string | null;
  source: BrowseSource | null;
  failureKind: BrowseFailureKind;
  title: string | null;
  detail: string | null;
  affectedSources: BrowseSource[];
  recommendedAction: {
    kind: RecommendedActionKind;
    reason: string | null;
    suppressed: boolean;
  };
  notification: BrowseIncidentTargetState & {
    notificationId: string | null;
  };
  suggestion: BrowseIncidentTargetState;
}

export interface BrowseSourceDiagnosis {
  source: BrowseSource;
  installed: boolean;
  authConfigured: boolean;
  refreshInFlight: boolean;
  providerId: string | null;
  providerReason: string | null;
  latestRun: SharedBrowserRunEvidence | null;
  consecutiveFailureCount: number;
  failureKind: BrowseFailureKind;
  failureScope: IncidentScope;
  detail: string | null;
  routeToIncidentKey: string | null;
}

export interface SharedBrowserHealthSummary {
  hoursQueried: number;
  checkedAt: string;
  cdpUrl: string;
  expectedConsumers: SharedBrowserConsumer[];
  liveProbe: SharedBrowserProbeResult | null;
  sessionProbe: SharedBrowserSessionProbeResult | null;
  explicitFailureCount: number;
  explicitFailures: SharedBrowserRunEvidence[];
  maskedRunCount: number;
  maskedRuns: SharedBrowserRunEvidence[];
  affectedSources: BrowseSource[];
  primaryIssue: 'shared_browser_outage' | 'none';
  primaryFailureKind: BrowseFailureKind;
  detail: string | null;
  dependencies: BrowseDependencyHealth[];
  sourceDiagnoses: BrowseSourceDiagnosis[];
  incident: BrowseIncidentRouting;
}

function toIncidentSlug(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildIncidentKey(input: {
  scope: Exclude<IncidentScope, 'none'>;
  failureKind: Exclude<BrowseFailureKind, 'none'>;
  dependencyId?: string | null;
  source?: BrowseSource | null;
}) {
  if (input.scope === 'provider') {
    return `browse:provider:${input.dependencyId || 'unknown'}:${input.failureKind}`;
  }

  return `browse:source:${input.source || 'unknown'}:${input.failureKind}`;
}

function buildNotificationId(incidentKey: string) {
  return `browse-incident-${toIncidentSlug(incidentKey)}`;
}

function buildSuggestionSourceId(incidentKey: string) {
  return `browse-suggestion-${toIncidentSlug(incidentKey)}`;
}

function compactErrorMessage(error: string | null | undefined) {
  const normalized = typeof error === 'string' ? error.trim() : '';
  return normalized || null;
}

function resolveKnownSource(value: unknown): BrowseSource | null {
  return typeof value === 'string' && KNOWN_SOURCES.includes(value as BrowseSource)
    ? value as BrowseSource
    : null;
}

function getConfiguredSharedBrowserCdpUrl() {
  return getSharedBrowserCdpUrl(process.env.X_BROWSER_CDP_URL);
}

function getSharedBrowserReason(source: BrowseSource) {
  switch (source) {
    case 'twitter':
      return 'Direct-browse Twitter skill uses the shared browser session.';
    case 'youtube':
      return 'Direct-browse YouTube skill uses the shared browser session.';
    case 'substack':
      return 'Direct-browse Substack skill uses the shared browser session.';
    default:
      return 'Direct-browse source uses the shared browser session.';
  }
}

export async function getSharedBrowserHealthSummary(
  hoursQueried: number,
): Promise<SharedBrowserHealthSummary> {
  const safeHours = Math.max(1, Math.floor(hoursQueried));
  const checkedAt = new Date().toISOString();
  const cdpUrl = getConfiguredSharedBrowserCdpUrl();
  const installedSkills = await listInstalledSkills();
  const installedSources = new Set<BrowseSource>();

  for (const skill of installedSkills) {
    const source = resolveKnownSource(skill.metadata?.['evogent']?.['feed-source']);
    if (source) {
      installedSources.add(source);
    }
  }

  const expectedConsumers = [...installedSources]
    .filter((source) => SHARED_BROWSER_SOURCES.has(source))
    .map((source) => ({
      source,
      reason: getSharedBrowserReason(source),
    }));

  const shouldProbe = expectedConsumers.length > 0;
  const liveProbe = shouldProbe
    ? await probeSharedBrowserVersion({ cdpUrl, timeoutMs: 1_500 })
    : null;
  const sessionProbe = shouldProbe
    ? await probeSharedBrowserSession({ cdpUrl, timeoutMs: 1_500 })
    : null;
  const providerDetail = liveProbe && !liveProbe.ok
    ? compactErrorMessage(liveProbe.error)
    : sessionProbe && !sessionProbe.ok
      ? compactErrorMessage(sessionProbe.error)
      : null;
  const providerUnhealthy = Boolean((liveProbe && !liveProbe.ok) || (sessionProbe && !sessionProbe.ok));
  const twitterAuthProbe = installedSources.has('twitter') && !providerUnhealthy
    ? await probeSharedBrowserTwitterAuth({ cdpUrl, timeoutMs: 1_500 })
    : null;

  const dependency: BrowseDependencyHealth = {
    id: SHARED_BROWSER_PROVIDER_ID,
    label: 'Shared browser',
    status: expectedConsumers.length === 0
      ? 'unused'
      : providerUnhealthy
        ? 'degraded'
        : 'healthy',
    detail: providerDetail,
    consumers: expectedConsumers,
    liveProbe,
    sessionProbe,
    explicitFailureCount: 0,
    explicitFailures: [],
    maskedRunCount: 0,
    maskedRuns: [],
  };

  const sourceDiagnoses = KNOWN_SOURCES.map((source) => {
    const installed = installedSources.has(source);
    const usesSharedBrowser = SHARED_BROWSER_SOURCES.has(source);
    const authConfigured = source === 'twitter'
      ? (twitterAuthProbe ? twitterAuthProbe.ok : installed ? !providerUnhealthy : false)
      : installed;

    let failureKind: BrowseFailureKind = 'none';
    let failureScope: IncidentScope = 'none';
    let detail: string | null = null;

    if (installed && usesSharedBrowser && providerUnhealthy) {
      failureKind = 'provider_hung';
      failureScope = 'provider';
      detail = providerDetail || 'Shared browser session is unavailable.';
    } else if (source === 'twitter' && installed && twitterAuthProbe && !twitterAuthProbe.ok) {
      failureKind = 'auth';
      failureScope = 'source';
      detail = compactErrorMessage(twitterAuthProbe.error) || 'Shared browser is reachable but X auth is missing.';
    } else if (installed) {
      detail = 'Direct-browse source skill is installed. Assess coverage from curation scratchpads, task logs, and live rendered pages.';
    }

    const routeToIncidentKey = failureScope === 'provider'
      ? buildIncidentKey({
        scope: 'provider',
        dependencyId: SHARED_BROWSER_PROVIDER_ID,
        failureKind: 'provider_hung',
      })
      : failureScope === 'source' && failureKind !== 'none'
        ? buildIncidentKey({
          scope: 'source',
          source,
          failureKind,
        })
        : null;

    return {
      source,
      installed,
      authConfigured,
      refreshInFlight: false,
      providerId: installed && usesSharedBrowser ? SHARED_BROWSER_PROVIDER_ID : null,
      providerReason: installed && usesSharedBrowser ? getSharedBrowserReason(source) : null,
      latestRun: null,
      consecutiveFailureCount: failureKind === 'none' ? 0 : 1,
      failureKind,
      failureScope,
      detail,
      routeToIncidentKey,
    } satisfies BrowseSourceDiagnosis;
  });

  const affectedSources = sourceDiagnoses
    .filter((diagnosis) => diagnosis.failureKind !== 'none')
    .map((diagnosis) => diagnosis.source);
  const providerIncidentKey = providerUnhealthy
    ? buildIncidentKey({
      scope: 'provider',
      dependencyId: SHARED_BROWSER_PROVIDER_ID,
      failureKind: 'provider_hung',
    })
    : null;

  const incident: BrowseIncidentRouting = providerIncidentKey
    ? {
        scope: 'provider',
        key: providerIncidentKey,
        dependencyId: SHARED_BROWSER_PROVIDER_ID,
        source: null,
        failureKind: 'provider_hung',
        title: 'Shared browse provider degraded',
        detail: providerDetail,
        affectedSources,
        recommendedAction: {
          kind: 'notification',
          reason: 'Direct-browse source skills share the same browser session, so provider failures should route once at the shared-browser layer.',
          suppressed: false,
        },
        notification: {
          incidentKey: providerIncidentKey,
          notificationId: buildNotificationId(providerIncidentKey),
          active: false,
          itemId: null,
          sourceId: buildNotificationId(providerIncidentKey),
        },
        suggestion: {
          incidentKey: providerIncidentKey,
          active: false,
          itemId: null,
          sourceId: buildSuggestionSourceId(providerIncidentKey),
        },
      }
    : {
        scope: 'none',
        key: null,
        dependencyId: null,
        source: null,
        failureKind: 'none',
        title: null,
        detail: null,
        affectedSources: [],
        recommendedAction: {
          kind: 'none',
          reason: null,
          suppressed: false,
        },
        notification: {
          incidentKey: null,
          notificationId: null,
          active: false,
          itemId: null,
          sourceId: null,
        },
        suggestion: {
          incidentKey: null,
          active: false,
          itemId: null,
          sourceId: null,
        },
      };

  return {
    hoursQueried: safeHours,
    checkedAt,
    cdpUrl,
    expectedConsumers,
    liveProbe,
    sessionProbe,
    explicitFailureCount: 0,
    explicitFailures: [],
    maskedRunCount: 0,
    maskedRuns: [],
    affectedSources,
    primaryIssue: incident.scope === 'provider' ? 'shared_browser_outage' : 'none',
    primaryFailureKind: incident.failureKind,
    detail: incident.detail,
    dependencies: [dependency],
    sourceDiagnoses,
    incident,
  };
}
