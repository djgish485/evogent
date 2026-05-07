import { CompactInfoPopover } from '@/components/feed/compact-info-popover';
import { type AgentTranscriptTarget, type CurationTaskState, formatCurationItemsAdded, sanitizeTerminalOutput, type TaskTranscriptFallbackState } from '@/lib/agent-transcript';
import { type BrainProviderName, type BrainProviderStateResponse, type CodexReasoningEffort, getCodexBrowserToolsStatus } from '@/lib/brain-provider';
import { clampCodeFixReasoningEffortToProvider, type CodeFixReasoningEffort, formatCodeFixReasoningEffortLabel, getCodeFixReasoningOptions } from '@/lib/code-fix-reasoning-config';
import { type OrchestratorStatusResponse } from '@/lib/orchestrator';
import { useOverlayDismiss } from '@/lib/overlay-dismiss';
import { CODEX_REASONING_OPTIONS } from '@/lib/reasoning-effort';
import { formatChatTimestamp } from '@/lib/timestamps';
import { useEffect, useRef, useState } from 'react';

const USAGE_SUMMARY_CACHE_MS = 60_000;

type UsageSummaryResponse = {
  totalCostUsd?: number;
  breakdown?: Array<{ runs?: number | null }>;
  codex?: {
    short: { usedPercent?: number | null; resetsAt?: string | null };
    weekly: { usedPercent?: number | null; resetsAt?: string | null };
  } | null;
  codexUnavailable?: string;
};

function formatUsagePercent(value: number | null | undefined): string {
  const numberValue = Number(value);
  return Number.isFinite(numberValue)
    ? `${Number.isInteger(numberValue) ? numberValue : numberValue.toFixed(1).replace(/\.0$/, '')}%`
    : '0%';
}

export function useUsageSummaryLabels(open: boolean): {
  codexUsageLabel: string;
  codexUsageTitle?: string;
  claudeUsageLabel: string;
} {
  const [usageSummary, setUsageSummary] = useState<UsageSummaryResponse | null>(null);
  const [usageSummaryError, setUsageSummaryError] = useState(false);
  const usageSummaryFetchedAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    const fetchedAt = usageSummaryFetchedAtRef.current;
    if (fetchedAt !== null && Date.now() - fetchedAt < USAGE_SUMMARY_CACHE_MS) {
      return;
    }

    let cancelled = false;
    usageSummaryFetchedAtRef.current = Date.now();
    void fetch('/api/usage/summary?since=24h', { cache: 'no-store' })
      .then((response) => {
        if (!response.ok) {
          throw new Error('Failed to load usage summary');
        }
        return response.json() as Promise<UsageSummaryResponse>;
      })
      .then((data) => {
        if (!cancelled) {
          setUsageSummary(data);
          setUsageSummaryError(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setUsageSummaryError(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  const codexUsageLabel = usageSummary?.codex
    ? `Codex usage: 5h ${formatUsagePercent(usageSummary.codex.short.usedPercent)} · weekly ${formatUsagePercent(usageSummary.codex.weekly.usedPercent)}`
    : usageSummary
      ? `Codex usage: unavailable${usageSummary.codexUnavailable ? ` (${usageSummary.codexUnavailable})` : ''}`
      : usageSummaryError
        ? 'Codex usage: unavailable'
        : 'Codex usage: loading...';
  const codexUsageTitle = usageSummary?.codex
    ? `5h resets ${usageSummary.codex.short.resetsAt ?? 'unknown'} · weekly resets ${usageSummary.codex.weekly.resetsAt ?? 'unknown'}`
    : undefined;
  const claudeBreakdown = Array.isArray(usageSummary?.breakdown) ? usageSummary.breakdown : [];
  const claudeRuns = claudeBreakdown.reduce((sum, row) => (
    sum + (typeof row.runs === 'number' && Number.isFinite(row.runs) ? row.runs : 0)
  ), 0);
  const claudeCost = typeof usageSummary?.totalCostUsd === 'number' && Number.isFinite(usageSummary.totalCostUsd)
    ? usageSummary.totalCostUsd
    : 0;
  const claudeUsageLabel = usageSummary
    ? `Claude usage: $${claudeCost.toFixed(2)} · ${claudeRuns} runs (since 24h)`
    : usageSummaryError
      ? 'Claude usage: unavailable'
      : 'Claude usage: loading...';

  return {
    codexUsageLabel,
    codexUsageTitle,
    claudeUsageLabel,
  };
}

export function BrainProviderSwitcherModal({
  open,
  status,
  error,
  isLoading,
  isSubmitting,
  targetProvider,
  codexReasoningEffort,
  onClose,
  onTargetProviderChange,
  onCodexReasoningEffortChange,
  onSubmit,
}: {
  open: boolean;
  status: BrainProviderStateResponse | null;
  error: string | null;
  isLoading: boolean;
  isSubmitting: boolean;
  targetProvider: BrainProviderName;
  codexReasoningEffort: CodexReasoningEffort;
  onClose: () => void;
  onTargetProviderChange: (provider: BrainProviderName) => void;
  onCodexReasoningEffortChange: (effort: CodexReasoningEffort) => void;
  onSubmit: () => void;
}) {
  const { backdropProps } = useOverlayDismiss({
    enabled: open,
    onClose,
    closeOnBackdropPress: !isSubmitting,
    closeOnEscape: !isSubmitting,
  });

  if (!open) {
    return null;
  }

  const targetAvailability = status?.providers[targetProvider] ?? null;
  const isNoop = Boolean(
    status
    && targetProvider === status.currentProvider
    && (targetProvider !== 'codex' || codexReasoningEffort === status.codexReasoningEffort),
  );
  const isBusy = Boolean(status?.isProcessing);
  const isSubmitDisabled = isLoading
    || isSubmitting
    || !status
    || !targetAvailability?.available
    || isBusy
    || isNoop;

  return (
    <div className="fixed inset-0 z-[90]">
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-black/70"
        {...backdropProps}
      />
      <div className="absolute inset-x-0 bottom-0 top-auto mx-auto flex max-h-[92vh] w-full max-w-lg items-end justify-center p-4 sm:items-center">
        <div
          data-testid="brain-provider-switcher"
          className="w-full overflow-hidden rounded-[1.5rem] border border-zinc-800 bg-zinc-950 shadow-[0_24px_80px_rgba(0,0,0,0.55)]"
        >
          <div className="flex items-start justify-between border-b border-zinc-800 px-5 py-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">App Brain</p>
              <h2 className="mt-1 text-lg font-semibold text-zinc-50">Switch provider</h2>
              <p className="mt-1 text-sm text-zinc-400">
                Choose which CLI powers the source browsing and default curation & chats.
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-2 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200"
              aria-label="Close provider switcher"
              disabled={isSubmitting}
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          <div className="space-y-4 px-5 py-4">
            {isLoading ? (
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 px-4 py-3 text-sm text-zinc-400">
                Checking installed providers...
              </div>
            ) : null}

            {error ? (
              <div className="rounded-2xl border border-rose-500/30 bg-rose-950/60 px-4 py-3 text-sm text-rose-200">
                {error}
              </div>
            ) : null}

            <div className="grid gap-3">
              {(['claude', 'codex'] as const).map((provider) => {
                const availability = status?.providers[provider] ?? null;
                const isActive = status?.currentProvider === provider;
                const isSelected = targetProvider === provider;
                const isAvailable = availability?.available ?? false;
                const browserToolsStatus = getCodexBrowserToolsStatus(availability);
                return (
                  <button
                    key={provider}
                    type="button"
                    onClick={() => onTargetProviderChange(provider)}
                    className={`rounded-2xl border px-4 py-3 text-left transition ${
                      isSelected
                        ? 'border-sky-400/70 bg-sky-500/10'
                        : 'border-zinc-800 bg-zinc-900/60 hover:border-zinc-700 hover:bg-zinc-900'
                    }`}
                    data-testid={`brain-provider-option-${provider}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold text-zinc-100">
                            {availability?.providerDisplayName ?? (provider === 'codex' ? 'Codex CLI' : 'Claude Code')}
                          </span>
                          {isActive ? (
                            <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-200">
                              Current
                            </span>
                          ) : null}
                        </div>
                        <p className="mt-1 text-xs text-zinc-400">
                          {provider === 'codex'
                            ? 'Uses GPT-5.5 through Codex CLI.'
                            : 'Uses Claude Code for the app brain.'}
                        </p>
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
                          <span className={`rounded-full px-2 py-0.5 ${
                            isAvailable
                              ? 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
                              : 'border border-rose-500/30 bg-rose-500/10 text-rose-200'
                          }`}>
                            {isAvailable ? 'CLI Available' : 'CLI Unavailable'}
                          </span>
                          {availability?.version ? (
                            <span className="rounded-full border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-zinc-400">
                              {availability.version}
                            </span>
                          ) : null}
                          {browserToolsStatus ? (
                            <span className={`rounded-full px-2 py-0.5 ${
                              browserToolsStatus.ok
                                ? 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
                                : 'border border-amber-500/30 bg-amber-500/10 text-amber-100'
                            }`}>
                              Browser tools: {browserToolsStatus.label}
                            </span>
                          ) : null}
                        </div>
                        {!isAvailable && availability?.error ? (
                          <p className="mt-2 text-xs text-rose-300">{availability.error}</p>
                        ) : null}
                        {browserToolsStatus ? (
                          <div
                            className={`mt-2 border-l-2 pl-3 text-xs ${
                              browserToolsStatus.ok
                                ? 'border-emerald-500/40 text-emerald-100/90'
                                : 'border-amber-400/50 text-amber-100'
                            }`}
                            data-testid={`brain-provider-browser-tools-${provider}`}
                          >
                            <p className="font-medium">Browser-backed sources</p>
                            <p className="mt-0.5">{browserToolsStatus.message}</p>
                            {browserToolsStatus.action ? (
                              <p className="mt-1 text-amber-100/80">{browserToolsStatus.action}</p>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                      {isSelected ? (
                        <span className="mt-0.5 inline-flex h-6 w-6 items-center justify-center rounded-full bg-sky-400/15 text-sky-300">
                          <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4">
                            <path d="M16.704 4.153a.75.75 0 0 1 .143 1.052l-8 10.5a.75.75 0 0 1-1.127.075l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 0 1 1.05-.143z" fill="currentColor" />
                          </svg>
                        </span>
                      ) : null}
                    </div>
                  </button>
                );
              })}
            </div>

            {targetProvider === 'codex' ? (
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4">
                <p className="text-sm font-medium text-zinc-100">Codex reasoning</p>
                <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {CODEX_REASONING_OPTIONS.map((option) => {
                    const isSelected = codexReasoningEffort === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => onCodexReasoningEffortChange(option.value)}
                        className={`rounded-xl border px-3 py-2 text-sm transition ${
                          isSelected
                            ? 'border-sky-400/70 bg-sky-500/10 text-sky-100'
                            : 'border-zinc-700 bg-zinc-950 text-zinc-300 hover:border-zinc-600'
                        }`}
                        data-testid={`codex-reasoning-option-${option.value}`}
                      >
                        {option.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}

            <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
              Switching starts a fresh chat session for the selected provider. Your older Claude and Codex sessions stay in history.
            </div>

            {isBusy ? (
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 px-4 py-3 text-sm text-zinc-300">
                Wait for the current task to finish before switching.
                {status?.currentTask?.messagePreview ? (
                  <p className="mt-1 text-xs text-zinc-500">{status.currentTask.messagePreview}</p>
                ) : status?.queueDepth ? (
                  <p className="mt-1 text-xs text-zinc-500">{status.queueDepth} queued task{status.queueDepth === 1 ? '' : 's'} still pending.</p>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="flex items-center justify-between border-t border-zinc-800 px-5 py-4">
            <p className="text-xs text-zinc-500">
              Current: {status?.currentProviderLabel ?? 'Loading...'}
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-xl border border-zinc-700 px-3 py-2 text-sm text-zinc-300 transition hover:border-zinc-600 hover:bg-zinc-900"
                disabled={isSubmitting}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onSubmit}
                className={`rounded-xl px-3 py-2 text-sm font-medium transition ${
                  isSubmitDisabled
                    ? 'cursor-not-allowed bg-zinc-800 text-zinc-500'
                    : 'bg-sky-500 text-sky-950 hover:bg-sky-400'
                }`}
                disabled={isSubmitDisabled}
                data-testid="brain-provider-switch-submit"
              >
                {isSubmitting ? 'Switching...' : 'Switch provider'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function UsageSummaryModal({
  isOpen,
  onClose,
  codexUsageLabel,
  codexUsageTitle,
  claudeUsageLabel,
}: {
  isOpen: boolean;
  onClose: () => void;
  codexUsageLabel: string;
  codexUsageTitle?: string;
  claudeUsageLabel: string;
}) {
  const { backdropProps } = useOverlayDismiss({
    enabled: isOpen,
    onClose,
  });

  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[90]">
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-black/70"
        {...backdropProps}
      />
      <div className="absolute inset-x-0 bottom-0 top-auto mx-auto flex max-h-[92vh] w-full max-w-md items-end justify-center p-4 sm:items-center">
        <div
          data-testid="brain-provider-usage-modal"
          className="w-full overflow-hidden rounded-[1.5rem] border border-zinc-800 bg-zinc-950 shadow-[0_24px_80px_rgba(0,0,0,0.55)]"
        >
          <div className="flex items-start justify-between border-b border-zinc-800 px-5 py-4">
            <div>
              <h2 className="text-lg font-semibold text-zinc-50">Usage</h2>
              <p className="mt-1 text-sm text-zinc-400">Coding agent usage so far</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-2 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200"
              aria-label="Close usage summary"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          <div className="px-5 py-4">
            <div
              className="rounded-2xl border border-zinc-800 bg-zinc-900/60 px-4 py-2 text-sm text-zinc-400"
              data-testid="brain-provider-usage-summary"
            >
              <p className="flex min-h-8 items-center border-b border-zinc-800/70 py-1.5" title={codexUsageTitle}>
                {codexUsageLabel}
              </p>
              <p className="flex min-h-8 items-center py-1.5">
                {claudeUsageLabel}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function FeedEmptyLoadingState() {
  return (
    <div data-testid="feed-empty-loading-state" aria-live="polite" aria-busy="true" className="space-y-2">
      <div className="overflow-hidden rounded-2xl border border-zinc-800 bg-gradient-to-br from-zinc-950 via-zinc-950 to-zinc-900 p-5 shadow-[0_0_0_1px_rgba(255,255,255,0.02)]">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-emerald-500/25 bg-emerald-500/10 text-emerald-200">
            <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5 animate-spin">
              <circle cx="12" cy="12" r="9" className="fill-none stroke-current opacity-25" strokeWidth="2.5" />
              <path d="M12 3a9 9 0 0 1 9 9" className="fill-none stroke-current" strokeLinecap="round" strokeWidth="2.5" />
            </svg>
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium text-zinc-100">Gathering your first posts</p>
            <p className="mt-1 text-xs leading-5 text-zinc-400">Checking recent sources and preparing the first set of posts for your feed.</p>
            <div className="mt-3 inline-flex items-center gap-2 rounded-full border border-zinc-800 bg-black/30 px-2.5 py-1 text-[11px] text-zinc-500">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
              Building the feed layout
            </div>
          </div>
        </div>
      </div>

      {Array.from({ length: 2 }, (_, index) => (
        <div
          key={`feed-loading-skeleton-${index}`}
          aria-hidden="true"
          className="rounded-2xl border border-zinc-900 bg-zinc-950/80 p-4"
        >
          <div className="animate-pulse space-y-3">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-full bg-zinc-800" />
              <div className="flex-1 space-y-2">
                <div className={`h-3 rounded-full bg-zinc-800 ${index === 0 ? 'w-36' : 'w-44'}`} />
                <div className="h-2 rounded-full bg-zinc-900 w-24" />
              </div>
            </div>
            <div className="space-y-2">
              <div className="h-3 rounded-full bg-zinc-800" />
              <div className="h-3 w-11/12 rounded-full bg-zinc-800" />
              <div className={`h-3 rounded-full bg-zinc-900 ${index === 0 ? 'w-3/4' : 'w-2/3'}`} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function TaskTranscriptPanel({
  taskId,
  transcriptText,
  fallback,
  isTaskActive,
}: {
  taskId: string;
  transcriptText: string;
  fallback?: TaskTranscriptFallbackState;
  isTaskActive: boolean;
}) {
  const transcriptContainerRef = useRef<HTMLPreElement | null>(null);
  const liveTranscript = sanitizeTerminalOutput(transcriptText);
  const fallbackTranscript = sanitizeTerminalOutput(fallback?.text || '');
  const transcriptToRender = (isTaskActive && liveTranscript)
    ? liveTranscript
    : fallbackTranscript || liveTranscript;

  useEffect(() => {
    const element = transcriptContainerRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [transcriptToRender]);

  return (
    <div className="space-y-2 rounded-lg border border-zinc-700/80 bg-black/35 p-2">
      <p className="text-[11px] text-zinc-400">Task: {taskId}</p>

      {transcriptToRender ? (
        <pre
          ref={transcriptContainerRef}
          className="max-h-56 overflow-y-auto overscroll-contain whitespace-pre-wrap rounded border border-zinc-800 bg-black/45 p-2 font-mono text-[11px] text-zinc-300"
        >
          {transcriptToRender}
        </pre>
      ) : fallback?.loading ? (
        <p className="text-xs text-zinc-400">Loading transcript...</p>
      ) : fallback?.error ? (
        <p className="text-xs text-rose-300">{fallback.error}</p>
      ) : (
        <pre
          ref={transcriptContainerRef}
          className="max-h-56 overflow-y-auto overscroll-contain whitespace-pre-wrap rounded border border-zinc-800 bg-black/45 p-2 font-mono text-[11px] text-zinc-300"
        >
          {fallbackTranscript || 'No transcript captured.'}
        </pre>
      )}
    </div>
  );
}

export function CurationTaskCard({
  task,
  agentName,
  taskTranscripts,
  taskTranscriptFallbacks,
  orchestratorStatus,
  expandedAgentTranscript,
  onToggleTranscript,
}: {
  task: CurationTaskState;
  agentName: string;
  taskTranscripts: Record<string, string>;
  taskTranscriptFallbacks: Record<string, TaskTranscriptFallbackState>;
  orchestratorStatus: OrchestratorStatusResponse | null;
  expandedAgentTranscript: AgentTranscriptTarget | null;
  onToggleTranscript: (target: AgentTranscriptTarget) => void;
}) {
  const transcriptTarget = task.transcriptTarget;
  const isTranscriptOpen = Boolean(transcriptTarget && expandedAgentTranscript?.key === transcriptTarget.key);
  const transcriptText = task.taskId ? taskTranscripts[task.taskId] || '' : '';
  const statusBadgeClass = task.status === 'completed'
    ? 'border-emerald-700/60 bg-emerald-950/20 text-emerald-100'
    : task.status === 'failed'
      ? 'border-rose-700/60 bg-rose-950/20 text-rose-100'
      : 'border-amber-700/60 bg-amber-950/20 text-amber-100';
  const badgeText = task.status === 'completed'
    ? 'COMPLETED'
    : task.status === 'failed'
      ? 'FAILED'
      : 'RUNNING';
  const helperText = task.status === 'running'
    ? `${agentName} is keeping the transcript live while this curation runs.`
    : task.status === 'completed'
      ? 'The live transcript remains available alongside the finished curation.'
      : 'The transcript is still available so you can inspect the failed curation run.';

  return (
    <div className={`rounded-xl border p-3 ${statusBadgeClass}`}>
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="inline-flex items-center gap-1.5 font-medium uppercase tracking-wide">
          <svg aria-hidden="true" viewBox="0 0 24 24" className="h-3.5 w-3.5">
            <path
              d="M11 4a7 7 0 1 0 4.95 11.95l3.55 3.55 1.4-1.4-3.55-3.55A7 7 0 0 0 11 4Zm0 2a5 5 0 1 1 0 10 5 5 0 0 1 0-10Z"
              className="fill-current"
            />
          </svg>
          CURATION TASK
        </span>
        <span className="text-zinc-500">{formatChatTimestamp(task.updatedAt)}</span>
      </div>

      <div className="mt-2 flex items-start gap-3">
        <div className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border ${
          task.status === 'completed'
            ? 'border-emerald-500/40 bg-emerald-500/10'
            : task.status === 'failed'
              ? 'border-rose-500/40 bg-rose-500/10'
              : 'border-amber-500/40 bg-amber-500/10'
        }`}>
          {task.status === 'running' ? (
            <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4 animate-spin">
              <circle cx="12" cy="12" r="9" className="fill-none stroke-current opacity-30" strokeWidth="2.5" />
              <path d="M12 3a9 9 0 0 1 9 9" className="fill-none stroke-current" strokeLinecap="round" strokeWidth="2.5" />
            </svg>
          ) : task.status === 'completed' ? (
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
          ) : (
            <span className="h-2.5 w-2.5 rounded-full bg-rose-400" />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium text-zinc-100">
              {task.status === 'completed'
                ? 'Curation complete'
                : task.status === 'failed'
                  ? 'Curation failed'
                  : 'Curating your feed...'}
            </p>
            <span className="rounded-full border border-current/20 bg-black/20 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide">
              {badgeText}
            </span>
          </div>
          {task.status === 'completed' && task.itemsAdded !== null && (
            <p className="mt-1 text-xs text-zinc-300">{formatCurationItemsAdded(task.itemsAdded)}</p>
          )}
          {task.status === 'failed' && task.error && (
            <p className="mt-1 text-xs text-rose-200">{task.error}</p>
          )}
          <p className="mt-1 text-[11px] text-zinc-400">{helperText}</p>
        </div>
      </div>

      {transcriptTarget && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
          <button
            type="button"
            onClick={() => {
              onToggleTranscript(transcriptTarget);
            }}
            className="rounded border border-zinc-700/80 bg-black/30 px-2 py-0.5 text-zinc-200 hover:bg-black/45"
          >
            {isTranscriptOpen ? 'Hide Transcript' : 'View Transcript'}
          </button>
        </div>
      )}

      {transcriptTarget?.taskId && isTranscriptOpen && (
        <div className="mt-3">
          <TaskTranscriptPanel
            taskId={transcriptTarget.taskId}
            transcriptText={transcriptText}
            fallback={taskTranscriptFallbacks[transcriptTarget.taskId]}
            isTaskActive={orchestratorStatus?.currentTask?.id === transcriptTarget.taskId}
          />
        </div>
      )}
    </div>
  );
}

export function ChatCurationStatusBanner({
  task,
}: {
  task: CurationTaskState;
}) {
  const statusClassName = task.status === 'completed'
    ? 'border-emerald-700/60 bg-emerald-950/20 text-emerald-100'
    : task.status === 'failed'
      ? 'border-rose-700/60 bg-rose-950/20 text-rose-100'
      : 'border-amber-700/60 bg-amber-950/20 text-amber-100';
  const headline = task.status === 'completed'
    ? 'Curation complete'
    : task.status === 'failed'
      ? 'Curation failed'
      : 'Curating your feed';
  const detail = task.status === 'completed'
    ? 'Feed refresh status lives here instead of in the transcript.'
    : task.status === 'failed'
      ? (task.error || 'The last curation run did not finish successfully.')
      : 'Feed refresh is running in the background while this conversation stays focused on chat.';

  return (
    <div
      data-testid="chat-curation-status-banner"
      className={`rounded-2xl border px-3 py-2.5 ${statusClassName}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-current/80">Feed Status</p>
          <p className="mt-1 text-sm font-medium text-zinc-50">{headline}</p>
          <p className="mt-1 text-xs leading-5 text-current/85">{detail}</p>
        </div>
        <span className="shrink-0 text-[11px] text-current/70">{formatChatTimestamp(task.updatedAt)}</span>
      </div>
    </div>
  );
}

export type SidebarAutomationControlsProps = {
  automaticCurationEnabled: boolean;
  backgroundSourceBrowsingEnabled: boolean;
  configLoaded: boolean;
  isSavingAutomaticCuration: boolean;
  isSavingBackgroundSourceBrowsing: boolean;
  isStartingSourceHealth: boolean;
  automaticCurationError: string | null;
  backgroundSourceBrowsingError: string | null;
  onToggleAutomaticCuration: () => void;
  onToggleBackgroundSourceBrowsing: () => void;
  onStartSourceHealth: () => void;
};

export function SidebarAutomationControls({
  automaticCurationEnabled,
  backgroundSourceBrowsingEnabled,
  configLoaded,
  isSavingAutomaticCuration,
  isSavingBackgroundSourceBrowsing,
  isStartingSourceHealth,
  automaticCurationError,
  backgroundSourceBrowsingError,
  onToggleAutomaticCuration,
  onToggleBackgroundSourceBrowsing,
  onStartSourceHealth,
}: SidebarAutomationControlsProps) {
  return (
    <section className="rounded-xl border border-zinc-800/90 bg-zinc-950/70 px-3 py-3">
      <div className="relative flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 text-sm text-zinc-100">
          Automatic curation
          <CompactInfoPopover title="Automatic curation" buttonLabel="View automatic curation details" triggerVariant="minimal">
            <p>Adaptive heartbeat pauses when off. Manual refresh still works.</p>
          </CompactInfoPopover>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={automaticCurationEnabled}
          aria-label="Toggle automatic curation"
          data-testid="automatic-curation-toggle"
          disabled={!configLoaded || isSavingAutomaticCuration}
          onClick={onToggleAutomaticCuration}
          className={`relative inline-flex h-7 w-12 shrink-0 rounded-full border transition-colors ${
            automaticCurationEnabled
              ? 'border-emerald-500/70 bg-emerald-500/20'
              : 'border-zinc-700 bg-zinc-800'
          } disabled:cursor-not-allowed disabled:opacity-60`}
        >
          <span
            aria-hidden="true"
            className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
              automaticCurationEnabled ? 'translate-x-6' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>
      {isSavingAutomaticCuration || !configLoaded ? (
        <div className="mt-2 flex items-center justify-between gap-3 text-[11px]">
          {isSavingAutomaticCuration ? <span className={automaticCurationEnabled ? 'text-emerald-300' : 'text-zinc-400'}>Saving...</span> : null}
          {!configLoaded ? <span className="text-zinc-500">Loading config...</span> : null}
        </div>
      ) : null}
      {automaticCurationError ? (
        <p className="mt-2 text-[11px] text-red-300">{automaticCurationError}</p>
      ) : null}

      <div className="mt-3 border-t border-zinc-800/80 pt-3">
        <div className="relative flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1 text-sm text-zinc-100">
            Background Browsing
            <CompactInfoPopover title="Background Browsing" buttonLabel="View background browsing details" triggerVariant="minimal">
              <p>Keeps new source items ready for curation.</p>
            </CompactInfoPopover>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={backgroundSourceBrowsingEnabled}
            aria-label="Toggle background browsing"
            data-testid="background-source-browsing-toggle"
            disabled={!configLoaded || isSavingBackgroundSourceBrowsing}
            onClick={onToggleBackgroundSourceBrowsing}
            className={`relative inline-flex h-7 w-12 shrink-0 rounded-full border transition-colors ${
              backgroundSourceBrowsingEnabled
                ? 'border-emerald-500/70 bg-emerald-500/20'
                : 'border-zinc-700 bg-zinc-800'
            } disabled:cursor-not-allowed disabled:opacity-60`}
          >
            <span
              aria-hidden="true"
              className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
                backgroundSourceBrowsingEnabled ? 'translate-x-6' : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>
        <div className="mt-2 flex items-center justify-between gap-3 text-[11px]">
          {isSavingBackgroundSourceBrowsing ? <span className={backgroundSourceBrowsingEnabled ? 'text-emerald-300' : 'text-zinc-400'}>Saving...</span> : null}
          <button
            type="button"
            data-testid="source-health-button"
            disabled={isStartingSourceHealth}
            onClick={onStartSourceHealth}
            className="ml-auto shrink-0 rounded-md border border-zinc-700 px-2 py-1 text-[11px] font-medium text-zinc-200 transition-colors hover:border-zinc-600 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isStartingSourceHealth ? 'Starting...' : 'Source Health'}
          </button>
        </div>
        {backgroundSourceBrowsingError ? (
          <p className="mt-2 text-[11px] text-red-300">{backgroundSourceBrowsingError}</p>
        ) : null}
      </div>
    </section>
  );
}

export type SidebarCodeFixReasoningButtonProps = {
  provider: BrainProviderName;
  value: CodeFixReasoningEffort;
  onOpen: () => void;
};

export function SidebarCodeFixReasoningButton({
  provider,
  value,
  onOpen,
}: SidebarCodeFixReasoningButtonProps) {
  const effectiveValue = clampCodeFixReasoningEffortToProvider(value, provider);
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="code-fix-reasoning-switcher"
      className="rounded-lg px-3 py-2.5 text-left text-sm text-zinc-200 transition-colors hover:bg-zinc-800"
    >
      <div className="flex items-center justify-between gap-3">
        <span>Code Fix Reasoning</span>
        <span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-[11px] font-medium text-sky-200">
          {formatCodeFixReasoningEffortLabel(effectiveValue)}
        </span>
      </div>
    </button>
  );
}

export function CodeFixReasoningSwitcherModal({
  open,
  provider,
  value,
  isSaving,
  error,
  onClose,
  onSelect,
}: {
  open: boolean;
  provider: BrainProviderName;
  value: CodeFixReasoningEffort;
  isSaving: boolean;
  error: string | null;
  onClose: () => void;
  onSelect: (value: CodeFixReasoningEffort) => void;
}) {
  const { backdropProps } = useOverlayDismiss({
    enabled: open,
    onClose,
    closeOnBackdropPress: !isSaving,
    closeOnEscape: !isSaving,
  });

  if (!open) {
    return null;
  }

  const options = getCodeFixReasoningOptions(provider);
  const effectiveValue = clampCodeFixReasoningEffortToProvider(value, provider);

  return (
    <div className="fixed inset-0 z-[90]">
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-black/70"
        {...backdropProps}
      />
      <div className="absolute inset-x-0 bottom-0 top-auto mx-auto flex max-h-[92vh] w-full max-w-md items-end justify-center p-4 sm:items-center">
        <div
          data-testid="code-fix-reasoning-switcher-modal"
          className="w-full overflow-hidden rounded-[1.5rem] border border-zinc-800 bg-zinc-950 shadow-[0_24px_80px_rgba(0,0,0,0.55)]"
        >
          <div className="flex items-start justify-between border-b border-zinc-800 px-5 py-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Code Fix</p>
              <h2 className="mt-1 text-lg font-semibold text-zinc-50">Code Fix Reasoning</h2>
              <p className="mt-1 text-sm text-zinc-400">
                Reasoning effort used by the code-fix dev agent. Independent of cache and chat settings.
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-2 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200"
              aria-label="Close code fix reasoning picker"
              disabled={isSaving}
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          <div className="space-y-3 px-5 py-4">
            {error ? (
              <div className="rounded-2xl border border-rose-500/30 bg-rose-950/60 px-4 py-3 text-sm text-rose-200">
                {error}
              </div>
            ) : null}

            <div className="grid gap-2">
              {options.map((option) => {
                const isSelected = effectiveValue === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => onSelect(option.value)}
                    disabled={isSaving}
                    data-testid={`code-fix-reasoning-option-${option.value}`}
                    className={`rounded-2xl border px-4 py-3 text-left transition ${
                      isSelected
                        ? 'border-sky-400/70 bg-sky-500/10'
                        : 'border-zinc-800 bg-zinc-900/60 hover:border-zinc-700 hover:bg-zinc-900'
                    } disabled:cursor-not-allowed disabled:opacity-60`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-semibold text-zinc-100">{option.label}</span>
                      {isSelected ? (
                        <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-sky-400/15 text-sky-300">
                          <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4">
                            <path d="M16.704 4.153a.75.75 0 0 1 .143 1.052l-8 10.5a.75.75 0 0 1-1.127.075l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 0 1 1.05-.143z" fill="currentColor" />
                          </svg>
                        </span>
                      ) : null}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex items-center justify-between border-t border-zinc-800 px-5 py-4">
            <p className="text-xs text-zinc-500">
              {isSaving ? 'Saving...' : `Active: ${formatCodeFixReasoningEffortLabel(effectiveValue)}`}
            </p>
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-zinc-700 px-3 py-2 text-sm text-zinc-300 transition hover:border-zinc-600 hover:bg-zinc-900"
              disabled={isSaving}
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
