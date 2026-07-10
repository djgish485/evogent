import type { ConversationSessionSummary } from '@/types/conversation';

export const SETUP_WIZARD_COMMAND = '/setup-wizard';
export const SETUP_WIZARD_ORIGIN_VIEW = 'feed/setup_card' as const;
export const SOURCE_STATUS_COMMAND = '/source-status';
export const SOURCE_HEALTH_ORIGIN_VIEW = 'feed/source_health_button' as const;
export const SOURCE_HEALTH_TRIGGER_SOURCE = 'source_health_button';

// Default composer target when nothing (valid) is selected: the durable main session
// first, then the most recently active non-curator session, then whatever exists.
// Quick questions must not land in the Curator thread just because it was touched last.
export function pickDefaultChatSessionId(
  sessions: ConversationSessionSummary[],
): string | null {
  const main = sessions.find((session) => session.sessionType === 'main');
  if (main) return main.sessionId;

  let latestGeneral: ConversationSessionSummary | null = null;
  for (const session of sessions) {
    if (session.sessionType === 'curator') continue;
    if (!latestGeneral || session.lastMaterialActivityAt > latestGeneral.lastMaterialActivityAt) {
      latestGeneral = session;
    }
  }
  if (latestGeneral) return latestGeneral.sessionId;

  return sessions[0]?.sessionId ?? null;
}

export function resolveGeneralChatSessionId(
  sessions: ConversationSessionSummary[],
  selectedSessionId: string | null | undefined,
): string | null {
  const selected = selectedSessionId?.trim()
    ? sessions.find((session) => session.sessionId === selectedSessionId.trim()) ?? null
    : null;

  if (selected && selected.sessionType !== 'curator') {
    return selected.sessionId;
  }

  let latest: ConversationSessionSummary | null = null;
  for (const session of sessions) {
    if (session.sessionType === 'curator') continue;
    if (!latest || session.lastMaterialActivityAt > latest.lastMaterialActivityAt) {
      latest = session;
    }
  }

  return latest?.sessionId ?? null;
}

export function resolveSetupWizardSessionId(
  sessions: ConversationSessionSummary[],
  selectedSessionId: string | null | undefined,
): string | null {
  return resolveGeneralChatSessionId(sessions, selectedSessionId);
}

export function resolveSourceHealthSessionId(
  sessions: ConversationSessionSummary[],
  selectedSessionId: string | null | undefined,
): string | null {
  return resolveGeneralChatSessionId(sessions, selectedSessionId);
}
