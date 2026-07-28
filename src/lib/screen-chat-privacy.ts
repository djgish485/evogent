export type ScreenChatContextKind = 'global' | 'post' | 'screen';

export const SCREEN_CHAT_SESSION_TITLE = 'Quick question';

/**
 * Native screen metadata is private by default. The route may use it in memory before
 * submission, but only this fixed routing bit is allowed into chat or orchestrator records.
 */
export function getDurableChatRequestMetadata(
  contextKind: ScreenChatContextKind,
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (contextKind !== 'screen') {
    return metadata ?? {};
  }

  return metadata?.overlay === true ? { overlay: true } : {};
}

/**
 * Screen-backed sessions deliberately do not derive durable titles from native package names.
 */
export function getFreshChatSessionTitle(contextKind: ScreenChatContextKind): string | null {
  return contextKind === 'screen' ? SCREEN_CHAT_SESSION_TITLE : null;
}
