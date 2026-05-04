export interface PromptAddon {
  exists: boolean;
  path: string;
  data: Record<string, unknown>;
  body: string;
}

export function readPromptAddon(repoDir: string | undefined, relativePath: string): PromptAddon;
export function renderPromptAddonBody(body: string, variables?: Record<string, unknown>): string;
