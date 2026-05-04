import { type SessionCompactionPhase } from '@/lib/chat-session-compaction';
import { type OrchestratorStatusResponse, type OrchestratorTaskStatus } from '@/lib/orchestrator';
import { CODEX_MANUAL_COMPACTION_UNAVAILABLE_REASON } from '@/lib/page-constants';
import { getProviderContextMetrics } from '@/lib/provider-context-limits';

export type BrainUiState = 'idle' | 'working' | 'processing' | 'unavailable';

export type BrainProviderName = 'claude' | 'codex';

export type ClaudeReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type CodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

export type CurateCommand = '/curate' | '/curate-latest';

export function resolveBrainState(
  activity: { sessionExists: boolean; working: boolean },
  orchestrator: OrchestratorStatusResponse | null,
): BrainUiState {
  if (orchestrator?.brainAvailable === false) return 'unavailable';
  if (orchestrator?.currentTask?.priority === 'user_chat') return 'processing';
  if (orchestrator?.brain.working || orchestrator?.isProcessing || activity.working) return 'working';
  return 'idle';
}

export interface BrainProviderAvailabilityState {
  provider: BrainProviderName;
  providerDisplayName: string;
  providerBinary: string;
  available: boolean;
  version: string | null;
  error: string | null;
  diagnostics?: {
    browserTools?: BrainProviderBrowserToolsDiagnostic | null;
  } | null;
}

export interface BrainProviderBrowserToolsDiagnostic {
  ok: boolean;
  expectedCdpUrl: string;
  configuredCdpUrl: string | null;
  serverName: string | null;
  reason: string;
  message: string | null;
}

export interface BrainProviderStateResponse {
  currentProvider: BrainProviderName;
  currentProviderLabel: string;
  codexReasoningEffort: CodexReasoningEffort;
  providers: Record<BrainProviderName, BrainProviderAvailabilityState>;
  isProcessing: boolean;
  currentTask: OrchestratorTaskStatus | null;
  queueDepth: number;
  checkedAt: string;
}

export function getProviderChipLabel(provider: BrainProviderName): string {
  return provider === 'codex' ? 'Codex' : 'Claude';
}

export function getProviderDisplayName(provider: BrainProviderName): string {
  return provider === 'codex' ? 'Codex' : 'Claude Code';
}

export function getProviderModelDisplayName(provider: BrainProviderName): string {
  return provider === 'codex' ? 'GPT-5.5' : 'Opus 4.7';
}

export function getChatSessionHeaderProviderLabel(provider: BrainProviderName): string {
  return `${getProviderDisplayName(provider)} · ${getProviderModelDisplayName(provider)}`;
}

export function getCodexBrowserToolsStatus(
  availability: BrainProviderAvailabilityState | null,
): {
  ok: boolean;
  label: string;
  message: string;
  action: string | null;
} | null {
  if (availability?.provider !== 'codex') {
    return null;
  }

  const browserTools = availability.diagnostics?.browserTools;
  if (!browserTools) {
    return null;
  }

  const serverName = browserTools.serverName?.trim() || 'playwright';
  const expectedCdpUrl = browserTools.expectedCdpUrl;
  if (browserTools.ok) {
    return {
      ok: true,
      label: 'Ready',
      message: `Playwright MCP server "${serverName}" targets shared Chrome CDP ${expectedCdpUrl}.`,
      action: null,
    };
  }

  let message = browserTools.message?.trim() || `Codex Playwright MCP server "${serverName}" must target shared Chrome CDP ${expectedCdpUrl}.`;
  if (browserTools.reason === 'playwright_missing') {
    message = `Missing Playwright MCP server "${serverName}" for shared Chrome CDP ${expectedCdpUrl}.`;
  }

  return {
    ok: false,
    label: 'Missing',
    message,
    action: `Codex MCP setup: add server "${serverName}" with node scripts/start-playwright-mcp.js so it targets ${expectedCdpUrl}.`,
  };
}

export function formatCompactTokenCount(value: number): string {
  if (!Number.isFinite(value)) {
    return '0';
  }

  const normalized = Math.max(0, Math.floor(value));
  if (normalized >= 1_000_000) {
    const millions = normalized / 1_000_000;
    return Number.isInteger(millions) ? `${millions}M` : `${millions.toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (normalized >= 1_000) {
    if (normalized >= 100_000) {
      return `${Math.round(normalized / 1_000)}K`;
    }
    const thousands = normalized / 1_000;
    return Number.isInteger(thousands) ? `${thousands}K` : `${thousands.toFixed(1).replace(/\.0$/, '')}K`;
  }
  return String(normalized);
}

export interface ChatSessionContextHeaderSnapshot {
  provider: BrainProviderName;
  latestContextTokens: number | null;
  latestContextWindow: number | null;
  latestContextModel: string | null;
}

export function getChatSessionContextHeaderMetrics(session: ChatSessionContextHeaderSnapshot | null) {
  return session ? getProviderContextMetrics({
    provider: session.provider,
    latestContextTokens: session.latestContextTokens,
    latestContextWindow: session.latestContextWindow,
    latestContextModel: session.latestContextModel,
  }) : null;
}

export function canOpenChatSessionCompactPopover(session: ChatSessionContextHeaderSnapshot | null): boolean {
  return getChatSessionContextHeaderMetrics(session) !== null;
}

export function getChatSessionManualCompactionUnavailableReason(provider: BrainProviderName): string | null {
  return provider === 'codex' ? CODEX_MANUAL_COMPACTION_UNAVAILABLE_REASON : null;
}

export function getChatSessionCompactButtonState(input: {
  provider: BrainProviderName;
  phase: SessionCompactionPhase | null;
  hasActiveChatTurn: boolean;
}): {
  disabled: boolean;
  label: string;
  title: string;
  unavailableReason: string | null;
} {
  const unavailableReason = getChatSessionManualCompactionUnavailableReason(input.provider);
  if (unavailableReason) {
    return { disabled: true, label: 'Unavailable', title: unavailableReason, unavailableReason };
  }

  const activePhase = input.phase === 'queued'
    ? { label: 'Queued', title: 'Compact is queued and will start when the current chat turn finishes.' }
    : input.phase === 'running'
      ? { label: 'Compacting', title: 'Compacting this session now.' }
      : null;
  if (activePhase) {
    return { disabled: true, ...activePhase, unavailableReason: null };
  }

  return {
    disabled: false,
    label: 'Compact',
    title: input.hasActiveChatTurn
      ? 'Compact will queue and start when the current chat turn finishes.'
      : 'Compact this session to replace long history with a shorter summary.',
    unavailableReason: null,
  };
}
