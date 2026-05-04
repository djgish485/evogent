export type RestartLifecycleStatus = 'pending' | 'applying' | 'restarting' | 'consumed' | 'failed';

export interface RestartLifecycleState {
  status: RestartLifecycleStatus;
  commit: string | null;
  commitFull?: string | null;
  summary: string;
  pendingSource?: string | null;
  mergedAt?: string | null;
  pendingAt?: string | null;
  applyRequestedAt?: string | null;
  buildStartedAt?: string | null;
  buildCompletedAt?: string | null;
  restartCommandAt?: string | null;
  serviceReadyAt?: string | null;
  requestedBy?: string | null;
  triggerSource?: string | null;
  requestReferer?: string | null;
  requestUserAgent?: string | null;
  requestRemoteAddress?: string | null;
  requestForwardedFor?: string | null;
  error?: string | null;
  lastUpdatedAt?: string | null;
}
