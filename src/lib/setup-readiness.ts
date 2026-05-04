import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import { getDataPath } from '@/lib/data-dir';
import {
  DEFAULT_CURATOR_CHAT_SESSION_ID,
  DEFAULT_MAIN_CHAT_SESSION_ID,
  ensureDefaultAppChatSessions,
  getChatSession,
  type BrainProviderName,
} from '@/lib/db/chat-sessions';
import { listInstalledSkillsWithWarnings } from '@/lib/skills';
import {
  extractMarkdownSection,
  getBrainProviderBinary,
  getBrainProviderDisplayName,
  normalizeBrainProvider,
  readBrainConfig,
} from '../../lib/brain-config.js';
import {
  DEFAULT_CURATOR_AGENT_SESSION_TITLE,
  DEFAULT_GENERAL_AGENT_SESSION_TITLE,
} from './chat-session-title';
import { getLatestBrowseCacheSourceSetupRun, type BrowseCacheRefreshRunRecord } from './db/browse-cache';
import { getFeedItemById, insertOrIgnoreFeedItem } from './db/feed';
import { getDb } from './db/client';
import { resolveRuntimeWorkingDirectory } from './runtime-working-directory';
import type { FeedItem } from '@/types/feed';

const execFileAsync = promisify(execFile);
const PROVIDERS = ['claude', 'codex'] as const;
const SETUP_READINESS_STATE_ID = 'first-run-welcome';
export const SETUP_WELCOME_NOTIFICATION_ID = 'setup-welcome-notification';
export const SETUP_WELCOME_NOTIFICATION_SOURCE_ID = 'setup-readiness:welcome';
export const SETUP_WELCOME_NOTIFICATION_TITLE = 'Welcome to Evogent';
export const SETUP_WELCOME_NOTIFICATION_TEXT = [
  'Tap the Curate button in the Curator Agent to do your first curation; it takes a few minutes.',
  'After that, curations will happen automatically and will be ready when you check back.',
  'Chat with the Curator Agent any time with feedback or questions about the curation quality.',
  'The General Agent can be used for anything, including app development.',
].join(' ');
const BROWSER_SOURCE_SETUP_VERIFICATION = 'open shared Chrome CDP profile on 9222 -> sign in -> verify provider MCP wiring -> install %SKILL% -> run packaged setup-smoke /cache-refresh %SOURCE%';
const SOURCE_SETUP_HINTS: Record<string, {
  setupSource: string;
  skill: string;
  verification: string;
  requiresSetupSmoke: boolean;
}> = {
  twitter: {
    setupSource: '/setup-source x.com',
    skill: 'tweet-cache',
    verification: BROWSER_SOURCE_SETUP_VERIFICATION,
    requiresSetupSmoke: true,
  },
  youtube: {
    setupSource: '/setup-source youtube.com',
    skill: 'youtube-cache',
    verification: BROWSER_SOURCE_SETUP_VERIFICATION,
    requiresSetupSmoke: true,
  },
  substack: {
    setupSource: '/setup-source substack.com',
    skill: 'substack-cache',
    verification: BROWSER_SOURCE_SETUP_VERIFICATION,
    requiresSetupSmoke: true,
  },
  hackernews: {
    setupSource: 'install hackernews-cache',
    skill: 'hackernews-cache',
    verification: 'run packaged setup-smoke /cache-refresh %SOURCE%',
    requiresSetupSmoke: false,
  },
};

export interface ProviderAvailability {
  provider: BrainProviderName;
  providerDisplayName: string;
  providerBinary: string;
  available: boolean;
  version: string | null;
  error: string | null;
}

export interface SourceReadinessItem {
  source: string;
  label: string;
  skill: string;
  evidence: {
    runId: string;
    taskId: string | null;
    itemsAdded: number;
    completedAtMs: number | null;
  } | null;
}

export interface FirstRunReadiness {
  checkedAt: string;
  provider: {
    configured: BrainProviderName;
    selected: BrainProviderName | null;
    ready: boolean;
    blocked: boolean;
    message: string;
    providers: Record<BrainProviderName, ProviderAvailability>;
  };
  sessions: {
    ready: boolean;
    mainSessionId: string | null;
    curatorSessionId: string | null;
  };
  sources: {
    ready: boolean;
    items: SourceReadinessItem[];
    message: string;
    recommendedCommands: string[];
  };
  required: string[];
  pending: string[];
  ready: string[];
}

export interface ReadinessOptions {
  checkProviderAvailability?: (provider: BrainProviderName) => Promise<ProviderAvailability>;
  persistConfig?: boolean;
  bootstrapDefaultSessions?: boolean;
  ensureSessions?: boolean;
  notifyWelcomeNotification?: (item: FeedItem) => Promise<void> | void;
}

interface SetupReadinessStateRow {
  last_ready: number;
  welcome_notification_handled: number;
}

export async function checkProviderAvailability(provider: BrainProviderName): Promise<ProviderAvailability> {
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
    const code = typeof error === 'object' && error && 'code' in error
      ? String((error as { code?: unknown }).code ?? '')
      : '';
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

export async function getProviderReadiness(options: ReadinessOptions = {}): Promise<FirstRunReadiness['provider']> {
  const configPath = getDataPath('config.md');
  const configContent = readTextFile(configPath);
  const explicitProvider = getExplicitBrainProvider(configContent);
  const config = readBrainConfig(configPath);
  const configured = normalizeBrainProvider(config.provider) as BrainProviderName;
  const check = options.checkProviderAvailability ?? checkProviderAvailability;
  const [claude, codex] = await Promise.all(PROVIDERS.map((provider) => check(provider)));
  const providers = { claude, codex };

  if (!explicitProvider) {
    return {
      configured,
      selected: null,
      ready: false,
      blocked: true,
      message: 'Ask the user to choose Claude Code or Codex CLI in README Phase 2, then write ## Brain Provider in data/config.md.',
      providers,
    };
  }

  const selected = providers[configured].available ? configured : null;

  return {
    configured,
    selected,
    ready: Boolean(selected),
    blocked: !selected,
    message: selected
      ? `Brain provider CLI ready: ${getBrainProviderDisplayName(selected)}.`
      : 'Install Claude Code or Codex CLI, then run this setup check again.',
    providers,
  };
}

export async function getSourceReadiness(): Promise<FirstRunReadiness['sources']> {
  const { items } = await listInstalledSkillsWithWarnings();
  const installedSourceItems: SourceReadinessItem[] = items.flatMap((skill) => {
    const metadata = skill.metadata?.['evogent'];
    const source = typeof metadata?.['feed-source'] === 'string' ? metadata['feed-source'].trim() : '';
    if (!source) {
      return [];
    }
    const label = typeof metadata?.['feed-source-label'] === 'string' && metadata['feed-source-label'].trim()
      ? metadata['feed-source-label'].trim()
      : source;
    return {
      source,
      label,
      skill: skill.slug,
      evidence: null,
    };
  });
  const sourceItems = installedSourceItems.flatMap((item) => {
    const hint = SOURCE_SETUP_HINTS[item.source.trim().toLowerCase()];
    if (hint?.requiresSetupSmoke === false) {
      return [item];
    }

    const evidence = getSourceSetupEvidence(item.source);
    if (!evidence) {
      return [];
    }
    return [{ ...item, evidence }];
  });
  const installedButUnverified = installedSourceItems.filter((item) => {
    const hint = SOURCE_SETUP_HINTS[item.source.trim().toLowerCase()];
    if (hint?.requiresSetupSmoke === false) {
      return false;
    }

    return !sourceItems.some((readyItem) => readyItem.source === item.source);
  });

  const commands = ['twitter', 'youtube', 'substack', 'hackernews']
    .map((source) => getSourceSetupHint(source))
    .filter((hint): hint is string => Boolean(hint));

  return {
    ready: sourceItems.length > 0,
    items: sourceItems,
    message: getSourceReadinessMessage(sourceItems, installedButUnverified),
    recommendedCommands: commands,
  };
}

function readTextFile(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function getExplicitBrainProvider(configContent: string): BrainProviderName | null {
  const providerSection = extractMarkdownSection(configContent, 'Brain Provider');
  if (!providerSection) {
    return null;
  }
  const providerMatch = providerSection.match(/\b(claude(?:\s+code)?|codex(?:\s+cli)?)\b/i)?.[1] ?? '';
  return providerMatch ? normalizeBrainProvider(providerMatch) as BrainProviderName : null;
}

function getSourceSetupEvidence(source: string): SourceReadinessItem['evidence'] {
  const run = getLatestBrowseCacheSourceSetupRun(source);
  if (!run) {
    return null;
  }

  return {
    runId: run.id,
    taskId: parseSetupSourceTaskId(source, run),
    itemsAdded: run.itemsAdded,
    completedAtMs: run.completedAtMs,
  };
}

function parseSetupSourceTaskId(source: string, run: BrowseCacheRefreshRunRecord): string | null {
  const prefix = `setup-source-${source.trim().toLowerCase()}-`;
  return run.id.startsWith(prefix) ? run.id.slice(prefix.length) || null : null;
}

function getSourceReadinessMessage(
  readyItems: SourceReadinessItem[],
  installedButUnverified: SourceReadinessItem[],
): string {
  if (readyItems.length > 0) {
    const labels = readyItems.map((source) => {
      if (!source.evidence) return source.label;
      const task = source.evidence.taskId ? ` task=${source.evidence.taskId}` : '';
      return `${source.label} run=${source.evidence.runId}${task} rows=${source.evidence.itemsAdded}`;
    });
    return `Content source ready: ${labels.join(', ')}.`;
  }

  if (installedButUnverified.length > 0) {
    const hints = installedButUnverified
      .map((item) => getSourceSetupHint(item.source))
      .filter((hint): hint is string => Boolean(hint));
    return `Installed source skill still needs packaged setup-smoke evidence. Run ${hints[0] ?? 'the matching setup-smoke /cache-refresh command'}.`;
  }

  return 'Ask the user which content source to configure in README Phase 2, then install its source skill with setup-smoke evidence.';
}

export function getSourceSetupHint(source: string): string | null {
  const normalized = source.trim().toLowerCase();
  const hint = SOURCE_SETUP_HINTS[normalized];
  if (!hint) {
    return null;
  }
  return `${hint.setupSource} -> ${hint.verification
    .replace('%SKILL%', hint.skill)
    .replace('%SOURCE%', normalized)}`;
}

function recordReadinessAndMaybeCreateWelcomeNotification(setupReady: boolean): FeedItem | null {
  const db = getDb();
  const now = new Date().toISOString();
  const run = db.transaction(() => {
    const state = db.prepare(`
      SELECT last_ready, welcome_notification_handled
      FROM setup_readiness_state
      WHERE id = ?
    `).get(SETUP_READINESS_STATE_ID) as SetupReadinessStateRow | undefined;

    if (!state) {
      db.prepare(`
        INSERT INTO setup_readiness_state (id, last_ready, welcome_notification_handled, updated_at)
        VALUES (?, ?, ?, ?)
      `).run(
        SETUP_READINESS_STATE_ID,
        setupReady ? 1 : 0,
        setupReady ? 1 : 0,
        now,
      );
      return null;
    }

    const wasReady = state.last_ready === 1;
    const welcomeHandled = state.welcome_notification_handled === 1;
    const shouldCreateWelcome = setupReady && !wasReady && !welcomeHandled;
    let createdWelcome: FeedItem | null = null;

    if (shouldCreateWelcome) {
      const inserted = insertOrIgnoreFeedItem({
        id: SETUP_WELCOME_NOTIFICATION_ID,
        type: 'notification',
        source: 'system',
        sourceId: SETUP_WELCOME_NOTIFICATION_SOURCE_ID,
        title: SETUP_WELCOME_NOTIFICATION_TITLE,
        text: SETUP_WELCOME_NOTIFICATION_TEXT,
        metadata: {
          notificationId: SETUP_WELCOME_NOTIFICATION_SOURCE_ID,
          severity: 'info',
          dismissable: true,
        },
        publishedAt: now,
      });
      createdWelcome = inserted ? getFeedItemById(SETUP_WELCOME_NOTIFICATION_ID) : null;
    }

    db.prepare(`
      UPDATE setup_readiness_state
      SET last_ready = ?, welcome_notification_handled = ?, updated_at = ?
      WHERE id = ?
    `).run(
      setupReady ? 1 : 0,
      shouldCreateWelcome || welcomeHandled ? 1 : 0,
      now,
      SETUP_READINESS_STATE_ID,
    );

    return createdWelcome;
  });

  return run();
}

async function notifySetupWelcomeNotification(item: FeedItem, options: ReadinessOptions): Promise<void> {
  try {
    if (options.notifyWelcomeNotification) {
      await options.notifyWelcomeNotification(item);
      return;
    }
    const { notifyFeedUpdate } = await import('./curation-submit');
    await notifyFeedUpdate([item]);
  } catch (error) {
    console.warn('[setup-readiness] failed to notify clients about welcome notification', error);
  }
}

export async function getFirstRunReadiness(options: ReadinessOptions = {}): Promise<FirstRunReadiness> {
  const [provider, sources] = await Promise.all([
    getProviderReadiness(options),
    getSourceReadiness(),
  ]);

  let sessions: FirstRunReadiness['sessions'] = {
    ready: false,
    mainSessionId: null,
    curatorSessionId: null,
  };

  const shouldBootstrapDefaultSessions = options.bootstrapDefaultSessions === true
    || options.ensureSessions === true;

  if (provider.selected && shouldBootstrapDefaultSessions) {
    const ensured = ensureDefaultAppChatSessions({
      provider: provider.selected,
      workingDirectory: resolveRuntimeWorkingDirectory(),
    });
    sessions = {
      ready: true,
      mainSessionId: ensured.main.id,
      curatorSessionId: ensured.curator.id,
    };
  } else {
    const main = getChatSession(DEFAULT_MAIN_CHAT_SESSION_ID);
    const curator = getChatSession(DEFAULT_CURATOR_CHAT_SESSION_ID);
    sessions = {
      ready: Boolean(main && curator),
      mainSessionId: main?.id ?? null,
      curatorSessionId: curator?.id ?? null,
    };
  }

  const required: string[] = [];
  const pending: string[] = [];
  const ready: string[] = [];

  if (provider.ready) {
    ready.push(provider.message);
  } else {
    required.push(provider.message);
  }

  if (sessions.ready) {
    ready.push(
      `Default ${DEFAULT_GENERAL_AGENT_SESSION_TITLE} and ${DEFAULT_CURATOR_AGENT_SESSION_TITLE} chat sessions exist.`,
    );
  } else {
    pending.push('Default chat sessions can be created with the explicit bootstrap action after a runnable brain provider is available.');
  }

  if (sources.ready) {
    ready.push(sources.message);
  } else {
    required.push(sources.message);
  }

  const welcomeNotification = recordReadinessAndMaybeCreateWelcomeNotification(required.length === 0);
  if (welcomeNotification) {
    await notifySetupWelcomeNotification(welcomeNotification, options);
  }

  return {
    checkedAt: new Date().toISOString(),
    provider,
    sessions,
    sources,
    required,
    pending,
    ready,
  };
}

export function isAgentWorkProviderReady(readiness: Pick<FirstRunReadiness, 'provider'>): boolean {
  return readiness.provider.ready && Boolean(readiness.provider.selected);
}
