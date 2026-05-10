export type A2UIRenderTier = 'markdown' | 'a2ui' | 'mcpapp';

export interface A2UINode {
  id: string;
  type: string;
  props?: Record<string, unknown>;
  children?: A2UINode[];
}

export type A2UIActionSource = 'a2ui' | 'mcpapp';

export interface A2UIActionEvent {
  actionId: string;
  source: A2UIActionSource;
  nodeId?: string;
  payload?: Record<string, unknown>;
}
