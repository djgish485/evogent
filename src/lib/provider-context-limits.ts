export type ProviderContextStatus = 'normal' | 'warn' | 'critical';

export interface ProviderContextSnapshot {
  provider: string;
  latestContextTokens: number | null;
  latestContextWindow: number | null;
  latestContextModel: string | null;
}

export interface ProviderContextMetrics {
  contextTokens: number;
  limit: number;
  warnAt: number;
  criticalAt: number;
  utilization: number;
  utilizationPercent: number;
  status: ProviderContextStatus;
}

function normalizeModelId(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function resolveKnownClaudeLimit(modelId: string): number | null {
  if (modelId === 'claude-opus-4-7[1m]') {
    return 1_000_000;
  }
  if (modelId === 'claude-opus-4-7' || modelId === 'claude-sonnet-4-6') {
    return 200_000;
  }
  return null;
}

export function resolveProviderContextLimit(snapshot: Omit<ProviderContextSnapshot, 'latestContextTokens'>): number | null {
  const explicitWindow = Number.isFinite(snapshot.latestContextWindow)
    ? Math.max(1, Math.floor(Number(snapshot.latestContextWindow)))
    : null;
  if (explicitWindow) {
    return explicitWindow;
  }

  const modelId = normalizeModelId(snapshot.latestContextModel);
  if (snapshot.provider === 'claude') {
    return resolveKnownClaudeLimit(modelId) ?? 200_000;
  }

  return null;
}

export function getProviderContextMetrics(snapshot: ProviderContextSnapshot): ProviderContextMetrics | null {
  const contextTokens = Number.isFinite(snapshot.latestContextTokens)
    ? Math.max(0, Math.floor(Number(snapshot.latestContextTokens)))
    : null;
  const limit = resolveProviderContextLimit(snapshot);

  if (contextTokens === null || limit === null || limit <= 0) {
    return null;
  }

  if (snapshot.provider === 'codex' && contextTokens > limit * 2) {
    return null;
  }

  const utilization = contextTokens / limit;
  const warnAt = Math.round(limit * 0.5);
  const criticalAt = Math.round(limit * 0.8);
  const utilizationPercent = Math.max(0, Math.min(999, Math.round(utilization * 100)));
  const status: ProviderContextStatus = contextTokens >= criticalAt
    ? 'critical'
    : contextTokens >= warnAt
      ? 'warn'
      : 'normal';

  return {
    contextTokens,
    limit,
    warnAt,
    criticalAt,
    utilization,
    utilizationPercent,
    status,
  };
}
