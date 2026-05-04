import { randomUUID } from 'node:crypto';
import type { FeedItem, SuggestionStatus } from '@/types/feed';

export interface CodeFixRepairLink {
  suggestionId: string | null;
  taskId: string | null;
  status: SuggestionStatus | null;
}

export interface CodeFixFailureMetadata {
  category: string;
  fingerprint: string;
  incidentKey: string | null;
  summary: string;
  phase: string | null;
  error: string | null;
  terminalReason?: string | null;
  evidence?: string | null;
  terminal: boolean;
  autoRepairEligible: boolean;
  repair: CodeFixRepairLink | null;
  callbackStatus?: string;
  callbackFingerprint?: string;
  callbackQueuedAt?: string;
  callbackUpdatedAt?: string;
  callbackMessageId?: string | null;
  callbackError?: string;
  notificationId?: string;
  originSessionId?: string;
}

export interface CodeFixFailureClassification {
  category: string;
  fingerprint: string;
  incidentKey: string | null;
  summary: string;
  phase: string | null;
  error: string | null;
  terminalReason: string | null;
  autoRepairEligible: boolean;
  repairTitle: string | null;
  repairText: string | null;
  repairPrompt: string | null;
}

export interface CodeFixFailureInput {
  phase?: string | null;
  error?: string | null;
  logTail?: string | null;
  terminalReason?: string | null;
}

const TRANSIENT_FAILURE_PATTERN = /\b(?:lint regression|build failed|tests? failed|playwright failed|timed out|timeout|network|econnreset|websocket closed|429|503|rate limit|rebase conflict|merge failed)\b/i;
const PROVIDER_ENOENT_PATTERN = /\b(?:spawn\s+(claude|codex|gemini)\s+enoent|(?:claude|codex|gemini): command not found|provider binary unavailable|no such file or directory.*\b(?:claude|codex|gemini)\b)\b/i;
const PROVIDER_MISMATCH_PATTERN = /\b(?:wrong coding agent configured|wrong agent configured|switch the brain provider|only available when Evogent is powered by claude code|provider mismatch|unsupported command.*provider)\b/i;
const CITATION_AUDIT_PATTERN = /\b(?:citation(?:-audit)?|source attribution)\b/i;
const CONTRACT_PATTERN = /\b(?:contract|invariant|policy mismatch|required)\b/i;

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function inferProviderBinary(text: string): string | null {
  const providerMatch = text.match(/\b(claude|codex|gemini)\b/i);
  const provider = providerMatch?.[1]?.trim().toLowerCase() ?? '';
  if (provider === 'claude' || provider === 'codex' || provider === 'gemini') {
    return provider;
  }
  return null;
}

function compactFailureSummary(input: CodeFixFailureInput): string | null {
  const candidates = [
    normalizeOptionalString(input.error),
    normalizeOptionalString(input.terminalReason),
    normalizeOptionalString(input.logTail)
      ?.split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-12)
      .reverse()
      .find((line) => !/^===/.test(line) && !/^\[runner\]/i.test(line)),
  ].filter((value): value is string => Boolean(value));

  if (candidates.length === 0) {
    return null;
  }

  return candidates[0].replace(/\s+/g, ' ').trim().slice(0, 240);
}

export function classifyCodeFixFailure(input: CodeFixFailureInput): CodeFixFailureClassification {
  const phase = normalizeOptionalString(input.phase);
  const error = normalizeOptionalString(input.error);
  const logTail = normalizeOptionalString(input.logTail);
  const terminalReason = normalizeOptionalString(input.terminalReason);
  const combined = [phase, error, terminalReason, logTail].filter(Boolean).join('\n');
  const compact = compactFailureSummary(input);

  if (PROVIDER_ENOENT_PATTERN.test(combined)) {
    const provider = inferProviderBinary(combined) ?? 'unknown';
    const incidentKey = `dev-agent:provider-binary-missing:${provider}`;
    return {
      category: 'provider_binary_missing',
      fingerprint: incidentKey,
      incidentKey,
      summary: `Unrecoverable failure: ${provider === 'unknown' ? 'the configured coding provider binary' : `${provider} CLI`} is missing or unavailable.`,
      phase,
      error: compact ?? error,
      terminalReason,
      autoRepairEligible: true,
      repairTitle: provider === 'unknown'
        ? 'Repair missing dev-agent provider binary'
        : `Repair missing ${provider} CLI for dev agents`,
      repairText: provider === 'unknown'
        ? 'A code-fix task failed because the configured coding provider binary is missing or unavailable on the host.'
        : `A code-fix task failed because ${provider} CLI is missing or unavailable on the host.`,
      repairPrompt: provider === 'unknown'
        ? 'Audit the dev-agent dispatch path for missing provider binaries. Verify which CLI the system expects, restore the host dependency or fail earlier with explicit diagnostics, and repair the general mechanism so code-fix tasks stop reaching terminal failure when the provider binary is unavailable.'
        : `Audit the dev-agent dispatch path for ${provider} CLI availability. Restore the missing host dependency or fail earlier with explicit diagnostics, and repair the general mechanism so code-fix tasks stop reaching terminal failure when ${provider} is unavailable.`,
    };
  }

  if (PROVIDER_MISMATCH_PATTERN.test(combined)) {
    const incidentKey = 'dev-agent:brain-provider-mismatch';
    return {
      category: 'brain_provider_mismatch',
      fingerprint: incidentKey,
      incidentKey,
      summary: 'Unrecoverable failure: the configured coding agent/provider does not satisfy the task contract.',
      phase,
      error: compact ?? error,
      terminalReason,
      autoRepairEligible: true,
      repairTitle: 'Repair dev-agent provider mismatch',
      repairText: 'A code-fix task failed because the configured coding agent/provider did not match the task contract.',
      repairPrompt: 'Audit the code-fix dispatch path for brain-provider mismatches. Ensure the configured provider, supported commands, and launch instructions agree, fail early with explicit diagnostics when they do not, and repair the general mechanism so code-fix tasks stop dispatching with the wrong provider or unsupported command contract.',
    };
  }

  if (CITATION_AUDIT_PATTERN.test(combined) && CONTRACT_PATTERN.test(combined)) {
    const incidentKey = 'dev-agent:citation-audit-contract-failure';
    return {
      category: 'citation_audit_contract_failure',
      fingerprint: incidentKey,
      incidentKey,
      summary: 'Unrecoverable failure: the task hit a citation/source-attribution audit contract mismatch.',
      phase,
      error: compact ?? error,
      terminalReason,
      autoRepairEligible: true,
      repairTitle: 'Repair citation audit contract failure',
      repairText: 'A code-fix task failed because the citation/source-attribution audit contract was violated or mismatched.',
      repairPrompt: 'Audit the citation and source-attribution contract used by dev agents. Identify where the runtime expectation and the task output contract diverged, repair the shared mechanism, and add diagnostics so identical citation-audit failures route cleanly instead of terminating code-fix tasks.',
    };
  }

  if (CONTRACT_PATTERN.test(combined) && !TRANSIENT_FAILURE_PATTERN.test(combined)) {
    const incidentKey = 'dev-agent:task-contract-violation';
    return {
      category: 'task_contract_violation',
      fingerprint: incidentKey,
      incidentKey,
      summary: 'Unrecoverable failure: the task hit a policy, contract, or invariant mismatch.',
      phase,
      error: compact ?? error,
      terminalReason,
      autoRepairEligible: true,
      repairTitle: 'Repair dev-agent task contract violation',
      repairText: 'A code-fix task failed because the task contract or policy invariants did not line up with the live system.',
      repairPrompt: 'Audit the failing dev-agent contract or invariant. Identify the shared assumption that broke, repair the underlying dispatch or validation mechanism, and improve diagnostics so future tasks fail with one stable incident path instead of repeated terminal mismatches.',
    };
  }

  if (TRANSIENT_FAILURE_PATTERN.test(combined)) {
    return {
      category: 'transient_validation_failure',
      fingerprint: 'dev-agent:transient-validation-failure',
      incidentKey: null,
      summary: 'Task failed during validation or merge, but the failure looks transient or task-specific rather than an invariant mismatch.',
      phase,
      error: compact ?? error,
      terminalReason,
      autoRepairEligible: false,
      repairTitle: null,
      repairText: null,
      repairPrompt: null,
    };
  }

  return {
    category: 'terminal_unclassified_failure',
    fingerprint: 'dev-agent:terminal-unclassified-failure',
    incidentKey: null,
    summary: 'Task ended in a terminal error, but it did not match a stable unrecoverable incident class.',
    phase,
    error: compact ?? error,
    terminalReason,
    autoRepairEligible: false,
    repairTitle: null,
    repairText: null,
    repairPrompt: null,
  };
}

export function buildCodeFixFailureMetadata(
  classification: CodeFixFailureClassification,
  repair: CodeFixRepairLink | null,
  evidence: string | null = null,
): CodeFixFailureMetadata {
  return {
    category: classification.category,
    fingerprint: classification.fingerprint,
    incidentKey: classification.incidentKey,
    summary: classification.summary,
    phase: classification.phase,
    error: classification.error,
    ...(classification.terminalReason ? { terminalReason: classification.terminalReason } : {}),
    ...(typeof evidence === 'string' && evidence.trim() ? { evidence: evidence.trim() } : {}),
    terminal: true,
    autoRepairEligible: classification.autoRepairEligible,
    repair,
  };
}

export function buildRepairSuggestionSourceId(incidentKey: string): string {
  return `code-fix-repair-${slugify(incidentKey)}`;
}

export function buildRepairSuggestionInput(input: {
  incidentKey: string;
  classification: CodeFixFailureClassification;
  failedSuggestion: FeedItem;
  taskId: string;
}) {
  const now = new Date().toISOString();
  const sourceId = buildRepairSuggestionSourceId(input.incidentKey);
  const title = input.classification.repairTitle ?? 'Repair dev-agent failure';
  const text = [
    input.classification.repairText ?? 'A code-fix task failed with a stable unrecoverable incident.',
    `Latest failed suggestion: ${input.failedSuggestion.id}.`,
    `Latest failed task: ${input.taskId}.`,
  ].join(' ');

  return {
    id: `repair-${slugify(input.incidentKey)}-${randomUUID().slice(0, 8)}`,
    type: 'suggestion' as const,
    source: input.failedSuggestion.source ?? 'claude',
    sourceId,
    title,
    text,
    reason: `Repair coordinator incident ${input.incidentKey}`,
    publishedAt: now,
    metadata: {
      suggestionType: 'code_fix',
      proposedValue: input.classification.repairPrompt ?? input.classification.summary,
      incidentKey: input.incidentKey,
      repairCoordinator: true,
      repairOriginSuggestionId: input.failedSuggestion.id,
      repairOriginTaskId: input.taskId,
    },
  };
}

export function isActiveRepairSuggestionStatus(status: SuggestionStatus | null | undefined): boolean {
  return status === 'pending' || status === 'accepted' || status === 'dispatched' || status === 'running';
}

export function getCodeFixFailureFeedback(item: FeedItem): string | null {
  const failure = item.metadata?.codeFixFailure;
  if (!failure || typeof failure !== 'object') {
    return null;
  }

  const summary = typeof failure.summary === 'string' ? failure.summary.trim() : '';
  if (!summary) {
    return null;
  }

  const incidentKey = typeof failure.incidentKey === 'string' ? failure.incidentKey.trim() : '';
  const repair = failure.repair;
  const repairStatus = typeof repair?.status === 'string' ? repair.status.trim().toLowerCase() : '';
  const repairTaskId = typeof repair?.taskId === 'string' ? repair.taskId.trim() : '';

  const parts = [summary];
  if (incidentKey) {
    parts.push(`Incident: ${incidentKey}.`);
  }
  if (repairStatus === 'dispatched' || repairStatus === 'running') {
    parts.push(repairTaskId ? `Repair task ${repairTaskId} is active.` : 'Repair task is active.');
  } else if (repairStatus === 'failed') {
    parts.push('Repair attempt also failed.');
  } else if (repairStatus === 'merged') {
    parts.push('Repair attempt merged.');
  }

  return parts.join(' ');
}
