export const CHAT_COMPOSER_PASSWORD_MANAGER_ATTRIBUTES = {
  'data-form-type': 'other',
  'data-lpignore': 'true',
} as const;

export const CHAT_COMPOSER_FORM_TEXT_ENTRY_ATTRIBUTES = {
  autoComplete: 'off',
  ...CHAT_COMPOSER_PASSWORD_MANAGER_ATTRIBUTES,
} as const;

export const CHAT_COMPOSER_TEXTBOX_TEXT_ENTRY_ATTRIBUTES = {
  autoCorrect: 'on',
  autoCapitalize: 'sentences',
  spellCheck: true,
  ...CHAT_COMPOSER_PASSWORD_MANAGER_ATTRIBUTES,
} as const;

export function shouldSubmitChatComposerKeyDown(input: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  isMobileViewport: boolean;
}): boolean {
  if (input.key !== 'Enter') return false;
  if (input.metaKey || input.ctrlKey) return true;

  return !input.isMobileViewport && !input.shiftKey;
}

export function normalizeChatComposerText(value: string): string {
  return value
    .replace(/\u00A0/g, ' ')
    .replace(/\u200B/g, '')
    .replace(/\r/g, '');
}

export function normalizeFeedSearchQuery(value: string | null | undefined): string {
  if (!value) return '';

  return value
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 200);
}

export function buildSlashCommandComposerText(currentValue: string, commandName: string): string {
  const normalized = normalizeChatComposerText(currentValue);
  const commandText = `/${commandName}`;
  const trimmed = normalized.trim();

  if (!trimmed) {
    return `${commandText} `;
  }

  if (trimmed.startsWith('/')) {
    return normalized.replace(/^(\s*)\/[A-Za-z0-9_-]*/, `$1${commandText}`);
  }

  return `${commandText} ${trimmed}`;
}
