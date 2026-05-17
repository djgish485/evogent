import type { CurationStatusSnapshot, OrchestratorStatusResponse } from '@/lib/orchestrator';

export const STALE_CURATION_COMPLETION_MS = 30_000;

export type ActiveCurationPipelinePhase = 'caching' | 'curating' | 'enriching';

function normalizePhase(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null;
}

export function getCurationStatusSnapshot(
  orchestratorStatus: OrchestratorStatusResponse | null | undefined,
): CurationStatusSnapshot | null {
  return orchestratorStatus?.curationStatus ?? null;
}

export function getActiveCurationPipelinePhase(
  orchestratorStatus: OrchestratorStatusResponse | null | undefined,
): ActiveCurationPipelinePhase | null {
  const curationStatus = getCurationStatusSnapshot(orchestratorStatus);
  const normalizedPhase = normalizePhase(curationStatus?.phase);

  if (curationStatus?.active) {
    if (normalizedPhase === 'enriching' || normalizedPhase === 'post_enrichment') {
      return 'enriching';
    }

    if (!normalizedPhase || normalizedPhase === 'caching') {
      return 'caching';
    }

    return 'curating';
  }

  return null;
}

export function getActiveCurationTaskId(
  orchestratorStatus: OrchestratorStatusResponse | null | undefined,
): string | null {
  const curationStatus = getCurationStatusSnapshot(orchestratorStatus);
  if (typeof curationStatus?.phaseTaskId === 'string' && curationStatus.phaseTaskId.trim()) {
    return curationStatus.phaseTaskId.trim();
  }

  if (typeof curationStatus?.requestId === 'string' && curationStatus.requestId.trim()) {
    return curationStatus.requestId.trim();
  }

  return null;
}

export function hasActiveCurationTask(orchestratorStatus: OrchestratorStatusResponse | null | undefined): boolean {
  return getActiveCurationPipelinePhase(orchestratorStatus) !== null;
}

export function shouldAutoCompleteStaleCurationTask(
  startedAt: string,
  orchestratorStatus: OrchestratorStatusResponse | null | undefined,
  nowMs = Date.now(),
): boolean {
  if (hasActiveCurationTask(orchestratorStatus)) {
    return false;
  }

  const startedMs = Date.parse(startedAt);
  if (Number.isNaN(startedMs)) {
    return false;
  }

  return nowMs - startedMs >= STALE_CURATION_COMPLETION_MS;
}
