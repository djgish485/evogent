export const UNTRUSTED_CONTENT_CLOSE_MARKER: string;
export const UNTRUSTED_CONTENT_OPEN_MARKER: string;
export const UNTRUSTED_CONTENT_PROMPT_PRELUDE: string;

export function createPromptSafetyNonce(): string;
export function wrapUntrustedContent(text: unknown, kind?: string, nonce?: string): string;
