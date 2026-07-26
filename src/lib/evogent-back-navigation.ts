export type EvogentBackAction =
  | 'close-rename-session'
  | 'close-create-session'
  | 'close-code-fix-reasoning'
  | 'close-brain-provider'
  | 'close-usage'
  | 'close-mobile-menu'
  | 'close-chat-reasoning'
  | 'close-chat-compact'
  | 'close-chat-session-menu'
  | 'close-session-picker'
  | 'close-command-picker'
  | 'close-config'
  | 'close-preferences'
  | 'collapse-agent-transcript'
  | 'pop-detail'
  | 'close-group-detail';

export interface EvogentBackLayerState {
  renameSessionModalOpen: boolean;
  createSessionModalOpen: boolean;
  codeFixReasoningModalOpen: boolean;
  brainProviderModalOpen: boolean;
  usageModalOpen: boolean;
  mobileMenuOpen: boolean;
  chatReasoningPopoverOpen: boolean;
  chatCompactPopoverOpen: boolean;
  chatSessionMenuOpen: boolean;
  sessionPickerOpen: boolean;
  commandPickerOpen: boolean;
  configOpen: boolean;
  preferencesOpen: boolean;
  agentTranscriptExpanded: boolean;
  detailDepth: number;
  groupDetailOpen: boolean;
}

/**
 * Pick exactly one visible React layer for Android Back to unwind.
 *
 * The order follows the page's visual stacking: blocking dialogs first, then menus/panels,
 * followed by the detail/chat stack. A group detail can remain underneath a conversation opened
 * from it, so the detail stack intentionally closes before the group.
 */
export function resolveEvogentBackAction(
  state: EvogentBackLayerState,
): EvogentBackAction | null {
  if (state.renameSessionModalOpen) return 'close-rename-session';
  if (state.createSessionModalOpen) return 'close-create-session';
  if (state.codeFixReasoningModalOpen) return 'close-code-fix-reasoning';
  if (state.brainProviderModalOpen) return 'close-brain-provider';
  if (state.usageModalOpen) return 'close-usage';
  if (state.mobileMenuOpen) return 'close-mobile-menu';
  if (state.chatReasoningPopoverOpen) return 'close-chat-reasoning';
  if (state.chatCompactPopoverOpen) return 'close-chat-compact';
  if (state.chatSessionMenuOpen) return 'close-chat-session-menu';
  if (state.sessionPickerOpen) return 'close-session-picker';
  if (state.commandPickerOpen) return 'close-command-picker';
  if (state.configOpen) return 'close-config';
  if (state.preferencesOpen) return 'close-preferences';
  if (state.agentTranscriptExpanded) return 'collapse-agent-transcript';
  if (state.detailDepth > 0) return 'pop-detail';
  if (state.groupDetailOpen) return 'close-group-detail';
  return null;
}
