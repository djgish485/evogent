import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NextResponse } from 'next/server';
import { CONFIG_DOCUMENT_TARGETS, ensureConfigTargetIntegrity, persistConfigContent } from '@/lib/config-storage';
import { createChatSession, getConversationSessions } from '@/lib/db/chat-sessions';
import { getOrchestratorStatus } from '@/lib/orchestrator';
import {
  getBrainProviderBinary,
  getBrainProviderDisplayName,
  normalizeCodexReasoningEffort,
  parseBrainConfig,
  readBrainConfig,
  resolveCodeFixReasoningEffortForBrainProvider,
  updateBrainConfigContent,
  updateCodeFixReasoningEffortConfigContent,
} from '../../../../lib/brain-config.js';
import { checkCodexBrowserPrerequisites } from '../../../../lib/codex-browser-prerequisites.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const execFileAsync = promisify(execFile);
const CONFIG_TARGET = CONFIG_DOCUMENT_TARGETS.config;
const BRAIN_PROVIDER_SWITCH_BLOCKING_PRIORITIES = new Set([
  'user_chat',
  'user_ping',
  'heartbeat',
  'code_fix_spawn',
  'feed_action',
  'reflection',
]);
type BrainProviderName = 'claude' | 'codex';
type CodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';
type BrainProviderSwitchTask = { priority?: unknown } | null | undefined;

interface ProviderAvailability {
  provider: BrainProviderName;
  providerDisplayName: string;
  providerBinary: string;
  available: boolean;
  version: string | null;
  error: string | null;
  diagnostics?: {
    browserTools: Awaited<ReturnType<typeof checkCodexBrowserPrerequisites>>;
  } | null;
}

function mergeCodexAvailability(
  codexBase: ProviderAvailability,
  codexBrowserPrerequisites: Awaited<ReturnType<typeof checkCodexBrowserPrerequisites>> | null,
): ProviderAvailability {
  if (!codexBrowserPrerequisites) {
    return codexBase;
  }

  return {
    ...codexBase,
    diagnostics: {
      browserTools: codexBrowserPrerequisites,
    },
  };
}

function parseRequestedProvider(value: unknown): BrainProviderName | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (normalized === 'claude' || normalized === 'claudecode' || normalized === 'claudecodecli') {
    return 'claude';
  }
  if (normalized === 'codex' || normalized === 'codexcli') {
    return 'codex';
  }
  return null;
}

function isBrainProviderSwitchBlocked(currentTask: BrainProviderSwitchTask): boolean {
  const priority = currentTask?.priority;
  return typeof priority === 'string' && BRAIN_PROVIDER_SWITCH_BLOCKING_PRIORITIES.has(priority);
}

async function checkProviderAvailability(provider: BrainProviderName): Promise<ProviderAvailability> {
  const providerBinary = getBrainProviderBinary(provider);
  const providerDisplayName = getBrainProviderDisplayName(provider);

  try {
    const result = await execFileAsync(providerBinary, ['--version'], {
      timeout: 8_000,
      windowsHide: true,
      maxBuffer: 1024 * 128,
    });
    const rawVersion = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
    return {
      provider,
      providerDisplayName,
      providerBinary,
      available: true,
      version: rawVersion ? rawVersion.split(/\r?\n/, 1)[0] : null,
      error: null,
    };
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code ?? '') : '';
    const message = error instanceof Error ? error.message : 'Provider binary unavailable';
    return {
      provider,
      providerDisplayName,
      providerBinary,
      available: false,
      version: null,
      error: code === 'ENOENT' ? `${providerBinary} not found in PATH` : message,
    };
  }
}

async function loadBrainProviderState() {
  const config = readBrainConfig(CONFIG_TARGET.filePath);
  const [claude, codexBase, orchestrator] = await Promise.all([
    checkProviderAvailability('claude'),
    checkProviderAvailability('codex'),
    getOrchestratorStatus().catch(() => null),
  ]);
  const codexBrowserPrerequisites = codexBase.available
    ? await checkCodexBrowserPrerequisites({
        cwd: process.cwd(),
        env: process.env,
      })
    : null;
  const codex = mergeCodexAvailability(codexBase, codexBrowserPrerequisites);

  return {
    currentProvider: config.provider,
    currentProviderLabel: config.providerDisplayName,
    codexReasoningEffort: config.codexReasoningEffort as CodexReasoningEffort,
    providers: {
      claude,
      codex,
    },
    isProcessing: Boolean(orchestrator?.isProcessing),
    currentTask: orchestrator?.currentTask ?? null,
    queueDepth: orchestrator?.queueDepth ?? 0,
    checkedAt: new Date().toISOString(),
  };
}

export async function GET() {
  const state = await loadBrainProviderState();
  return NextResponse.json(state);
}

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
  }

  const provider = parseRequestedProvider((payload as { provider?: unknown }).provider);
  if (!provider) {
    return NextResponse.json({ error: 'provider must be one of: claude, codex' }, { status: 400 });
  }

  const codexReasoningEffort = normalizeCodexReasoningEffort(
    (payload as { codexReasoningEffort?: unknown }).codexReasoningEffort,
  ) as CodexReasoningEffort;

  const state = await loadBrainProviderState();
  if (isBrainProviderSwitchBlocked(state.currentTask)) {
    return NextResponse.json({
      error: 'Cannot switch providers while the agent is working. Wait for the current task to finish.',
      ...state,
    }, { status: 409 });
  }

  const targetAvailability = state.providers[provider];
  if (!targetAvailability.available) {
    return NextResponse.json({
      error: `${targetAvailability.providerDisplayName} is not available on this machine.`,
      ...state,
    }, { status: 409 });
  }

  const integrityState = await ensureConfigTargetIntegrity(CONFIG_TARGET);
  if (!integrityState.ok) {
    return NextResponse.json({
      error: integrityState.message,
      integrity: integrityState.integrity,
    }, { status: 500 });
  }
  const currentContent = integrityState.content;
  const currentConfig = parseBrainConfig(currentContent);

  let nextContent = updateBrainConfigContent(currentContent, {
    provider,
    codexReasoningEffort,
  });

  if (currentConfig.provider !== provider) {
    const syncedCodeFixReasoningEffort = resolveCodeFixReasoningEffortForBrainProvider(currentContent, provider, {
      codexReasoningEffort,
    });
    nextContent = updateCodeFixReasoningEffortConfigContent(nextContent, syncedCodeFixReasoningEffort);
  }

  if (nextContent !== currentContent) {
    const writeResult = await persistConfigContent({
      target: CONFIG_TARGET,
      content: nextContent,
      source: 'brain_provider',
    });
    if (!writeResult.ok) {
      return NextResponse.json({
        error: writeResult.message,
        integrity: writeResult.integrity,
      }, { status: writeResult.statusCode });
    }
  }

  const session = createChatSession({ provider, codexReasoningEffort });
  const sessions = getConversationSessions();
  const nextState = await loadBrainProviderState();

  return NextResponse.json({
    ok: true,
    content: nextContent,
    session,
    sessionId: session.id,
    sessions,
    ...nextState,
  });
}

export const __testOnly = {
  isBrainProviderSwitchBlocked,
  mergeCodexAvailability,
};
