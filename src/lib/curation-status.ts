import type { CurationStatusSnapshot, OrchestratorStatusResponse } from '@/lib/orchestrator';

export const STALE_CURATION_COMPLETION_MS = 30_000;

export type ActiveCurationPipelinePhase = 'caching' | 'curating' | 'enriching';

function isCurationInstructionPreview(value: string | null | undefined): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '/curate'
    || normalized.startsWith('/curate ')
    || normalized === '/curate-latest'
    || normalized.startsWith('/curate-latest ')
    || normalized.startsWith('heartbeat:')
    || normalized.includes('curation cycle');
}

function normalizePhase(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null;
}

function isLegacyCurationTask(orchestratorStatus: OrchestratorStatusResponse | null | undefined): boolean {
  if (!orchestratorStatus) return false;

  if (typeof orchestratorStatus.activeCurationAgent === 'string' && orchestratorStatus.activeCurationAgent.trim()) {
    return true;
  }

  const currentTask = orchestratorStatus.currentTask;
  if (!currentTask) return false;

  return currentTask.priority === 'heartbeat'
    || (currentTask.priority === 'user_ping' && isCurationInstructionPreview(currentTask.messagePreview));
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

  if (isLegacyCurationTask(orchestratorStatus)) {
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

  if (typeof orchestratorStatus?.activeCurationAgent === 'string' && orchestratorStatus.activeCurationAgent.trim()) {
    return orchestratorStatus.activeCurationAgent.trim();
  }

  const currentTask = orchestratorStatus?.currentTask;
  if (currentTask && isCurationInstructionPreview(currentTask.messagePreview)) {
    return currentTask.id;
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
