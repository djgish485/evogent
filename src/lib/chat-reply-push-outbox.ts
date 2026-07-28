import { createHash, randomUUID } from 'node:crypto';
import { getDb } from '@/lib/db/client';
import { getAppPresence } from '@/lib/db/presence';
import {
  getPushNotificationEventConfig,
  PUSH_NOTIFICATION_REQUEST_TIMEOUT_MS,
  readPushNotificationConfig,
  sendPushNotification,
  shouldSuppressPushNotification,
  type PushNotificationEventConfig,
  type PushNotificationsConfig,
} from '@/lib/push-notify';

// Immediate delivery plus twelve exponentially spaced retries reaches its last
// attempt about 20.5 hours later. That spans overnight/offline phone windows,
// stays inside the 24-hour pending lifetime, and caps network work at 13 calls.
export const CHAT_REPLY_PUSH_MAX_ATTEMPTS = 13;
export const CHAT_REPLY_PUSH_PENDING_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const CHAT_REPLY_PUSH_RECEIPT_RETENTION_MS = 8 * 24 * 60 * 60 * 1_000;
export const CHAT_REPLY_PUSH_RETRY_BASE_MS = 30_000;
export const CHAT_REPLY_PUSH_RETRY_MAX_MS = 6 * 60 * 60 * 1_000;

const CHAT_REPLY_PUSH_LEASE_MS = Math.max(
  PUSH_NOTIFICATION_REQUEST_TIMEOUT_MS * 3,
  15_000,
);
const CHAT_REPLY_PUSH_DRAIN_LIMIT = 32;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

const createChatReplyPushOutboxSql = `
CREATE TABLE IF NOT EXISTS chat_reply_push_outbox (
  message_id TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'delivered', 'suppressed', 'terminal')),
  terminal_reason TEXT,
  config_fingerprint TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at_ms INTEGER NOT NULL,
  pending_until_ms INTEGER NOT NULL,
  retire_at_ms INTEGER NOT NULL,
  lease_token TEXT,
  lease_until_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS chat_reply_push_outbox_due_idx
  ON chat_reply_push_outbox (state, next_attempt_at_ms);
`;

export type ChatReplyPushReceiptState =
  | 'pending'
  | 'delivered'
  | 'suppressed'
  | 'terminal';

export interface ChatReplyPushReceipt {
  messageId: string;
  state: ChatReplyPushReceiptState;
  terminalReason: string | null;
  attemptCount: number;
  nextAttemptAtMs: number;
  pendingUntilMs: number;
  retireAtMs: number;
  createdAtMs: number;
  updatedAtMs: number;
}

interface OutboxRow {
  message_id: string;
  state: ChatReplyPushReceiptState;
  terminal_reason: string | null;
  config_fingerprint: string | null;
  attempt_count: number;
  next_attempt_at_ms: number;
  pending_until_ms: number;
  retire_at_ms: number;
  lease_token: string | null;
  lease_until_ms: number | null;
  created_at_ms: number;
  updated_at_ms: number;
}

interface ClaimedOutboxRow extends OutboxRow {
  lease_token: string;
  lease_until_ms: number;
}

interface ChatReplyRow {
  id: string;
  type: string;
  role: string;
  text: string;
}

export interface ChatReplyPushDrainDependencies {
  now?: () => number;
  readConfig?: () => Promise<PushNotificationsConfig | null>;
  getPresence?: typeof getAppPresence;
  deliver?: (
    message: string,
    config: PushNotificationsConfig,
    eventConfig: PushNotificationEventConfig,
  ) => Promise<boolean>;
}

export interface ChatReplyPushDrainResult {
  delivered: number;
  suppressed: number;
  retried: number;
  terminal: number;
}

interface ChatReplyPushRuntimeState {
  running: Promise<void> | null;
  timer: ReturnType<typeof setTimeout> | null;
  rerunRequested: boolean;
}

declare global {
  // One process can load this module through more than one Next.js route chunk.
  // Keeping the runner on globalThis prevents those chunks from racing locally;
  // the SQLite lease also covers briefly overlapping server processes.
  var evogentChatReplyPushRuntime: ChatReplyPushRuntimeState | undefined;
}

function getRuntimeState(): ChatReplyPushRuntimeState {
  if (!globalThis.evogentChatReplyPushRuntime) {
    globalThis.evogentChatReplyPushRuntime = {
      running: null,
      timer: null,
      rerunRequested: false,
    };
  }
  return globalThis.evogentChatReplyPushRuntime;
}

function normalizeNow(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : Date.now();
}

function readReceipt(row: OutboxRow): ChatReplyPushReceipt {
  return {
    messageId: row.message_id,
    state: row.state,
    terminalReason: row.terminal_reason,
    attemptCount: row.attempt_count,
    nextAttemptAtMs: row.next_attempt_at_ms,
    pendingUntilMs: row.pending_until_ms,
    retireAtMs: row.retire_at_ms,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

function resolveDeliveryConfig(
  config: PushNotificationsConfig | null,
): {
  config: PushNotificationsConfig;
  eventConfig: PushNotificationEventConfig;
  fingerprint: string;
} | null {
  const eventConfig = getPushNotificationEventConfig(config, 'chat_reply');
  const topic = typeof config?.ntfy?.topic === 'string' ? config.ntfy.topic.trim() : '';
  if (!eventConfig || config?.provider !== 'ntfy' || !topic) return null;
  const server = typeof config.ntfy?.server === 'string' && config.ntfy.server.trim()
    ? config.ntfy.server.trim().replace(/\/+$/, '')
    : 'https://ntfy.sh';
  const fingerprint = createHash('sha256')
    .update(`ntfy\0${server}\0${topic}`)
    .digest('hex');
  return { config, eventConfig, fingerprint };
}

function cleanAndExpireReceipts(now: number): void {
  const db = getDb();
  db.prepare(`
    UPDATE chat_reply_push_outbox
    SET
      state = 'terminal',
      terminal_reason = 'retry_expired',
      lease_token = NULL,
      lease_until_ms = NULL,
      updated_at_ms = @now
    WHERE state = 'pending'
      AND pending_until_ms <= @now
      AND (lease_until_ms IS NULL OR lease_until_ms <= @now)
  `).run({ now });
  db.prepare(`
    DELETE FROM chat_reply_push_outbox
    WHERE retire_at_ms <= ?
  `).run(now);
}

function terminalizeAvailablePendingReceipts(reason: string, now: number): number {
  const result = getDb().prepare(`
    UPDATE chat_reply_push_outbox
    SET
      state = 'terminal',
      terminal_reason = @reason,
      lease_token = NULL,
      lease_until_ms = NULL,
      updated_at_ms = @now
    WHERE state = 'pending'
      AND (lease_until_ms IS NULL OR lease_until_ms <= @now)
  `).run({ reason, now });
  return result.changes;
}

function claimNextDueReceipt(now: number): ClaimedOutboxRow | null {
  const db = getDb();
  return db.transaction(() => {
    const candidate = db.prepare(`
      SELECT *
      FROM chat_reply_push_outbox
      WHERE state = 'pending'
        AND next_attempt_at_ms <= @now
        AND pending_until_ms > @now
        AND retire_at_ms > @now
        AND (lease_until_ms IS NULL OR lease_until_ms <= @now)
      ORDER BY next_attempt_at_ms ASC, created_at_ms ASC, message_id ASC
      LIMIT 1
    `).get({ now }) as OutboxRow | undefined;
    if (!candidate) return null;

    const leaseToken = randomUUID();
    const leaseUntilMs = now + CHAT_REPLY_PUSH_LEASE_MS;
    const claimed = db.prepare(`
      UPDATE chat_reply_push_outbox
      SET
        lease_token = @lease_token,
        lease_until_ms = @lease_until_ms,
        updated_at_ms = @now
      WHERE message_id = @message_id
        AND state = 'pending'
        AND (lease_until_ms IS NULL OR lease_until_ms <= @now)
    `).run({
      lease_token: leaseToken,
      lease_until_ms: leaseUntilMs,
      message_id: candidate.message_id,
      now,
    });
    if (claimed.changes !== 1) return null;

    return {
      ...candidate,
      lease_token: leaseToken,
      lease_until_ms: leaseUntilMs,
      updated_at_ms: now,
    };
  })();
}

function markClaimTerminal(
  row: ClaimedOutboxRow,
  state: 'delivered' | 'suppressed' | 'terminal',
  reason: string | null,
  now: number,
): boolean {
  const result = getDb().prepare(`
    UPDATE chat_reply_push_outbox
    SET
      state = @state,
      terminal_reason = @terminal_reason,
      lease_token = NULL,
      lease_until_ms = NULL,
      updated_at_ms = @now
    WHERE message_id = @message_id
      AND state = 'pending'
      AND lease_token = @lease_token
  `).run({
    state,
    terminal_reason: reason,
    now,
    message_id: row.message_id,
    lease_token: row.lease_token,
  });
  return result.changes === 1;
}

function markClaimFailed(row: ClaimedOutboxRow, now: number): 'retried' | 'terminal' {
  const attemptCount = row.attempt_count + 1;
  if (attemptCount >= CHAT_REPLY_PUSH_MAX_ATTEMPTS || now >= row.pending_until_ms) {
    getDb().prepare(`
      UPDATE chat_reply_push_outbox
      SET
        state = 'terminal',
        terminal_reason = @reason,
        attempt_count = @attempt_count,
        lease_token = NULL,
        lease_until_ms = NULL,
        updated_at_ms = @now
      WHERE message_id = @message_id
        AND state = 'pending'
        AND lease_token = @lease_token
    `).run({
      reason: now >= row.pending_until_ms ? 'retry_expired' : 'retry_exhausted',
      attempt_count: attemptCount,
      now,
      message_id: row.message_id,
      lease_token: row.lease_token,
    });
    return 'terminal';
  }

  getDb().prepare(`
    UPDATE chat_reply_push_outbox
    SET
      attempt_count = @attempt_count,
      next_attempt_at_ms = @next_attempt_at_ms,
      lease_token = NULL,
      lease_until_ms = NULL,
      updated_at_ms = @now
    WHERE message_id = @message_id
      AND state = 'pending'
      AND lease_token = @lease_token
  `).run({
    attempt_count: attemptCount,
    next_attempt_at_ms: now + getChatReplyPushRetryDelayMs(attemptCount),
    now,
    message_id: row.message_id,
    lease_token: row.lease_token,
  });
  return 'retried';
}

function getNextWakeAtMs(now: number): number | null {
  const row = getDb().prepare(`
    SELECT wake_at_ms
    FROM (
      SELECT
        MIN(
          CASE
            WHEN lease_until_ms IS NOT NULL AND lease_until_ms > @now
              THEN MAX(next_attempt_at_ms, lease_until_ms)
            ELSE next_attempt_at_ms
          END,
          pending_until_ms
        ) AS wake_at_ms
      FROM chat_reply_push_outbox
      WHERE state = 'pending'

      UNION ALL

      SELECT retire_at_ms AS wake_at_ms
      FROM chat_reply_push_outbox
    )
    ORDER BY wake_at_ms ASC
    LIMIT 1
  `).get({ now }) as { wake_at_ms: number | null } | undefined;
  return typeof row?.wake_at_ms === 'number' ? row.wake_at_ms : null;
}

function scheduleNextWake(): void {
  const runtime = getRuntimeState();
  if (runtime.timer) {
    clearTimeout(runtime.timer);
    runtime.timer = null;
  }

  try {
    const now = Date.now();
    cleanAndExpireReceipts(now);
    const wakeAtMs = getNextWakeAtMs(now);
    if (wakeAtMs === null) return;
    const delayMs = Math.min(Math.max(0, wakeAtMs - now), MAX_TIMER_DELAY_MS);
    runtime.timer = setTimeout(() => {
      runtime.timer = null;
      kickChatReplyPushOutbox();
    }, delayMs);
    runtime.timer.unref?.();
  } catch {
    // Startup recovery will retry durable receipts after a process/database restart.
  }
}

export function ensureChatReplyPushOutboxSchema(): void {
  const db = getDb();
  db.exec(createChatReplyPushOutboxSql);
  const columns = db.prepare(`PRAGMA table_info(chat_reply_push_outbox)`)
    .all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'config_fingerprint')) {
    try {
      db.exec(`ALTER TABLE chat_reply_push_outbox ADD COLUMN config_fingerprint TEXT;`);
    } catch (error) {
      const refreshedColumns = db.prepare(`PRAGMA table_info(chat_reply_push_outbox)`)
        .all() as Array<{ name: string }>;
      if (!refreshedColumns.some((column) => column.name === 'config_fingerprint')) {
        throw error;
      }
    }
  }
}

export function getChatReplyPushRetryDelayMs(attemptCount: number): number {
  const exponent = Math.max(0, Math.floor(attemptCount) - 1);
  return Math.min(
    CHAT_REPLY_PUSH_RETRY_BASE_MS * (2 ** exponent),
    CHAT_REPLY_PUSH_RETRY_MAX_MS,
  );
}

/**
 * Record the delivery decision only after the chat row is durable and its audit
 * append has been attempted. The receipt references the chat row instead of
 * duplicating reply text. Disabled/missing config creates a bounded terminal
 * tombstone so a later config change cannot turn an old reply into a stale push.
 */
export async function recordChatReplyPushReceipt(
  messageId: string,
  options: {
    now?: number;
    readConfig?: () => Promise<PushNotificationsConfig | null>;
  } = {},
): Promise<ChatReplyPushReceipt> {
  const normalizedMessageId = messageId.trim();
  if (!normalizedMessageId) {
    throw new Error('messageId is required');
  }

  let config: PushNotificationsConfig | null = null;
  try {
    config = await (options.readConfig ?? readPushNotificationConfig)();
  } catch {
    config = null;
  }
  const now = normalizeNow(options.now ?? Date.now());
  const deliveryConfig = resolveDeliveryConfig(config);
  const state: ChatReplyPushReceiptState = deliveryConfig
    ? 'pending'
    : 'terminal';
  const terminalReason = state === 'terminal' ? 'config_unavailable' : null;

  ensureChatReplyPushOutboxSchema();
  cleanAndExpireReceipts(now);
  getDb().prepare(`
    INSERT OR IGNORE INTO chat_reply_push_outbox (
      message_id,
      state,
      terminal_reason,
      config_fingerprint,
      attempt_count,
      next_attempt_at_ms,
      pending_until_ms,
      retire_at_ms,
      lease_token,
      lease_until_ms,
      created_at_ms,
      updated_at_ms
    )
    VALUES (
      @message_id,
      @state,
      @terminal_reason,
      @config_fingerprint,
      0,
      @now,
      @pending_until_ms,
      @retire_at_ms,
      NULL,
      NULL,
      @now,
      @now
    )
  `).run({
    message_id: normalizedMessageId,
    state,
    terminal_reason: terminalReason,
    config_fingerprint: deliveryConfig?.fingerprint ?? null,
    now,
    pending_until_ms: now + CHAT_REPLY_PUSH_PENDING_RETENTION_MS,
    retire_at_ms: now + CHAT_REPLY_PUSH_RECEIPT_RETENTION_MS,
  });

  const row = getDb().prepare(`
    SELECT *
    FROM chat_reply_push_outbox
    WHERE message_id = ?
  `).get(normalizedMessageId) as OutboxRow | undefined;
  if (!row) {
    throw new Error('Failed to persist chat reply push receipt');
  }
  return readReceipt(row);
}

/**
 * Drain due receipts. A provider can accept a request and the process can crash
 * before SQLite records success, so delivery is intentionally at-least-once and
 * that narrow crash window can produce a duplicate notification.
 */
export async function drainChatReplyPushOutbox(
  dependencies: ChatReplyPushDrainDependencies = {},
): Promise<ChatReplyPushDrainResult> {
  ensureChatReplyPushOutboxSchema();
  const nowFn = dependencies.now ?? Date.now;
  let now = normalizeNow(nowFn());
  cleanAndExpireReceipts(now);

  const result: ChatReplyPushDrainResult = {
    delivered: 0,
    suppressed: 0,
    retried: 0,
    terminal: 0,
  };

  let config: PushNotificationsConfig | null = null;
  try {
    config = await (dependencies.readConfig ?? readPushNotificationConfig)();
  } catch {
    config = null;
  }
  const deliveryConfig = resolveDeliveryConfig(config);
  if (!deliveryConfig) {
    result.terminal += terminalizeAvailablePendingReceipts('config_unavailable', now);
    return result;
  }

  const deliver = dependencies.deliver
    ?? ((message, activeConfig, eventConfig) => sendPushNotification('chat_reply', message, {
      config: activeConfig,
      title: eventConfig.title,
    }));
  const readPresence = dependencies.getPresence ?? getAppPresence;

  for (let processed = 0; processed < CHAT_REPLY_PUSH_DRAIN_LIMIT; processed += 1) {
    now = normalizeNow(nowFn());
    cleanAndExpireReceipts(now);
    const receipt = claimNextDueReceipt(now);
    if (!receipt) break;

    if (
      !receipt.config_fingerprint
      || receipt.config_fingerprint !== deliveryConfig.fingerprint
    ) {
      if (markClaimTerminal(receipt, 'terminal', 'config_changed', now)) {
        result.terminal += 1;
      }
      continue;
    }

    let presence = null;
    try {
      presence = readPresence();
    } catch {
      // Presence is a delivery optimization. Fail open to an extra push instead
      // of turning a presence read failure into a lost reply notification.
    }
    if (shouldSuppressPushNotification(presence, deliveryConfig.eventConfig, now)) {
      if (markClaimTerminal(receipt, 'suppressed', 'foreground', now)) {
        result.suppressed += 1;
      }
      continue;
    }

    const message = getDb().prepare(`
      SELECT id, type, role, text
      FROM chat_messages
      WHERE id = ?
    `).get(receipt.message_id) as ChatReplyRow | undefined;
    if (
      !message
      || message.type !== 'chat'
      || message.role !== 'agent'
      || !message.text.trim()
    ) {
      if (markClaimTerminal(receipt, 'terminal', 'message_unavailable', now)) {
        result.terminal += 1;
      }
      continue;
    }

    let delivered = false;
    try {
      delivered = await deliver(
        message.text,
        deliveryConfig.config,
        deliveryConfig.eventConfig,
      );
    } catch {
      console.warn('[chat-reply-push-outbox] delivery attempt failed');
    }

    now = normalizeNow(nowFn());
    if (delivered) {
      if (markClaimTerminal(receipt, 'delivered', null, now)) {
        result.delivered += 1;
      }
      continue;
    }

    const failureResult = markClaimFailed(receipt, now);
    result[failureResult] += 1;
  }

  return result;
}

export function kickChatReplyPushOutbox(): void {
  ensureChatReplyPushOutboxSchema();
  const runtime = getRuntimeState();
  if (runtime.timer) {
    clearTimeout(runtime.timer);
    runtime.timer = null;
  }
  if (runtime.running) {
    runtime.rerunRequested = true;
    return;
  }

  runtime.running = drainChatReplyPushOutbox()
    .then(() => undefined)
    .catch(() => {
      console.warn('[chat-reply-push-outbox] drain failed; durable receipts remain pending');
    })
    .finally(() => {
      runtime.running = null;
      if (runtime.rerunRequested) {
        runtime.rerunRequested = false;
        queueMicrotask(kickChatReplyPushOutbox);
        return;
      }
      scheduleNextWake();
    });
}

export function startChatReplyPushOutbox(): void {
  kickChatReplyPushOutbox();
}

export function scheduleChatReplyPushOutboxMaintenance(): void {
  ensureChatReplyPushOutboxSchema();
  if (!getRuntimeState().running) {
    scheduleNextWake();
  }
}

export async function waitForChatReplyPushOutboxIdleForTests(): Promise<void> {
  const runtime = getRuntimeState();
  while (runtime.running) {
    await runtime.running;
    await Promise.resolve();
  }
}

export function resetChatReplyPushOutboxRuntimeForTests(): void {
  const runtime = getRuntimeState();
  if (runtime.timer) {
    clearTimeout(runtime.timer);
  }
  runtime.timer = null;
  runtime.rerunRequested = false;
}
