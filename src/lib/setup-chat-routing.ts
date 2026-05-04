import type { ConversationSessionSummary } from '@/types/conversation';

export const SETUP_WIZARD_COMMAND = '/setup-wizard';
export const SETUP_WIZARD_ORIGIN_VIEW = 'feed/setup_card' as const;
export const SOURCE_STATUS_COMMAND = '/source-status';
export const SOURCE_HEALTH_ORIGIN_VIEW = 'feed/source_health_button' as const;
export const SOURCE_HEALTH_TRIGGER_SOURCE = 'source_health_button';

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
