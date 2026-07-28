import { getDb } from './client';
import { getServerProcessEpoch } from '@/lib/server-process-epoch';

export type AppPresenceState = 'foreground' | 'background';

export interface AppPresenceRecord {
  state: AppPresenceState;
  clientId: string;
  lastSeenAt: string;
}

export const APP_PRESENCE_GENERATION_ID_MAX_LENGTH = 128;
export const APP_PRESENCE_GENERATIONS_RETAINED = 256;

const APP_PRESENCE_GENERATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isAppPresenceState(value: unknown): value is AppPresenceState {
  return value === 'foreground' || value === 'background';
}

export function normalizeAppPresenceGenerationId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (
    !normalized
    || normalized.length > APP_PRESENCE_GENERATION_ID_MAX_LENGTH
    || !APP_PRESENCE_GENERATION_ID.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

export function normalizeAppPresenceSequence(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function toIso(timestamp: string | undefined): string {
  if (!timestamp) return new Date().toISOString();
  const parsed = new Date(timestamp);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString();
}

/**
 * Refreshes the one-row app-presence lease.
 *
 * Each page owns one random generation and advances a sequence for every
 * foreground/background report. A small, bounded generation ledger gives those
 * random ids a durable server order. The singleton row then accepts only a
 * higher generation order or a higher sequence within the same generation, so
 * delayed heartbeats and pagehide requests cannot reverse newer lifecycle
 * evidence. Transport pings never become behavioral history.
 */
export function recordAppPresence(
  state: AppPresenceState,
  generationId: string,
  sequence: number,
  timestamp?: string,
): boolean {
  const canonicalGenerationId = normalizeAppPresenceGenerationId(generationId);
  const canonicalSequence = normalizeAppPresenceSequence(sequence);
  if (!isAppPresenceState(state) || !canonicalGenerationId || canonicalSequence === null) {
    return false;
  }

  const db = getDb();
  const lastSeenAt = toIso(timestamp);
  const serverEpoch = getServerProcessEpoch();

  return db.transaction(() => {
    let generation = db.prepare(`
      SELECT generation_order
      FROM app_presence_generations
      WHERE generation_id = ?
    `).get(canonicalGenerationId) as { generation_order: number } | undefined;

    if (!generation) {
      db.prepare(`
        INSERT OR IGNORE INTO app_presence_generations (generation_id)
        VALUES (?)
      `).run(canonicalGenerationId);
      generation = db.prepare(`
        SELECT generation_order
        FROM app_presence_generations
        WHERE generation_id = ?
      `).get(canonicalGenerationId) as { generation_order: number } | undefined;
      if (!generation) return false;

      db.prepare(`
        DELETE FROM app_presence_generations
        WHERE generation_order <= @generation_order - @retained
      `).run({
        generation_order: generation.generation_order,
        retained: APP_PRESENCE_GENERATIONS_RETAINED,
      });
    }

    // Background is the fail-open state for delivery. Registering a previously
    // unseen generation here is intentional: a page can hide before its first
    // foreground request reaches the server. Recording the higher background
    // sequence prevents that delayed foreground from later suppressing pushes.
    // In the ambiguous case this can cause one extra notification, never a
    // missed notification while the app is actually hidden.
    const result = db.prepare(`
      INSERT INTO app_presence (
        id,
        state,
        client_id,
        last_seen_at,
        server_epoch,
        generation_id,
        generation_sequence,
        generation_order
      )
      VALUES (
        1,
        @state,
        @generation_id,
        @last_seen_at,
        @server_epoch,
        @generation_id,
        @generation_sequence,
        @generation_order
      )
      ON CONFLICT(id) DO UPDATE SET
        state = excluded.state,
        client_id = excluded.client_id,
        last_seen_at = excluded.last_seen_at,
        server_epoch = excluded.server_epoch,
        generation_id = excluded.generation_id,
        generation_sequence = excluded.generation_sequence,
        generation_order = excluded.generation_order
      WHERE app_presence.generation_order IS NULL
        OR excluded.generation_order > app_presence.generation_order
        OR (
          excluded.generation_order = app_presence.generation_order
          AND (
            app_presence.generation_sequence IS NULL
            OR excluded.generation_sequence > app_presence.generation_sequence
          )
        )
    `).run({
      state,
      generation_id: canonicalGenerationId,
      last_seen_at: lastSeenAt,
      server_epoch: serverEpoch,
      generation_sequence: canonicalSequence,
      generation_order: generation.generation_order,
    });
    return result.changes === 1;
  })();
}

export function getAppPresence(): AppPresenceRecord | null {
  const row = getDb().prepare(`
    SELECT state, generation_id, last_seen_at
    FROM app_presence
    WHERE id = 1
      AND server_epoch = @server_epoch
      AND generation_id IS NOT NULL
      AND generation_sequence > 0
      AND generation_order > 0
  `).get({
    server_epoch: getServerProcessEpoch(),
  }) as {
    state: AppPresenceState;
    generation_id: string;
    last_seen_at: string;
  } | undefined;

  if (!row) return null;
  return {
    state: row.state,
    clientId: row.generation_id,
    lastSeenAt: row.last_seen_at,
  };
}
