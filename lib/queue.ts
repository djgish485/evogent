export const BACKGROUND_QUEUE_NAME = 'evogent-background' as const;

export const BACKGROUND_JOB_NAMES = {
  HEARTBEAT: 'heartbeat',
  CURATION: 'curation',
  REFLECTION: 'reflection',
  USER_CHAT: 'user_chat',
  POST_ENRICHMENT: 'post_enrichment',
  CONFIG_APPLY: 'config_apply',
} as const;

export type BackgroundJobName = typeof BACKGROUND_JOB_NAMES[keyof typeof BACKGROUND_JOB_NAMES];

interface BackgroundJobBase {
  requestId?: string;
}

export interface HeartbeatJobData extends BackgroundJobBase {
  triggeredBy: string;
}

export interface CurationJobData extends BackgroundJobBase {
  message: string;
  priority: 'heartbeat' | 'user_ping';
  source: string;
  metadata?: Record<string, unknown> | null;
  timeoutMs?: number;
}

export interface ReflectionJobData extends BackgroundJobBase {
  message: string;
  priority: 'reflection';
  source: string;
  metadata?: Record<string, unknown> | null;
  timeoutMs?: number;
}

export interface UserChatJobData extends BackgroundJobBase {
  message: string;
  priority: 'user_chat';
  source: string;
  metadata?: Record<string, unknown> | null;
  timeoutMs?: number;
}

export interface PostEnrichmentJobData extends BackgroundJobBase {
  message: string;
  priority: 'post_enrichment';
  source: string;
  metadata?: Record<string, unknown> | null;
  timeoutMs?: number;
}

export interface ConfigApplyJobData extends BackgroundJobBase {
  task: {
    taskId: string;
    suggestionId: string;
    target: 'config' | 'curation-prompt';
    relativePath: 'data/config.md' | 'data/curation-prompt.md';
    sectionName: string;
    proposedValue: string;
    diff?: string;
  };
}

export interface BackgroundJobDataMap {
  heartbeat: HeartbeatJobData;
  curation: CurationJobData;
  reflection: ReflectionJobData;
  user_chat: UserChatJobData;
  post_enrichment: PostEnrichmentJobData;
  config_apply: ConfigApplyJobData;
}

export type BackgroundJobPayload<Name extends BackgroundJobName = BackgroundJobName> = {
  name: Name;
  data: BackgroundJobDataMap[Name];
};

export interface BackgroundJobEnqueueResult {
  ok: boolean;
  duplicate?: boolean;
  jobId: string | null;
  queueDepth: number;
}

export interface DrainStaleBackgroundJobsResult {
  removed: number;
  removedByState: {
    active: number;
    waiting: number;
  };
  jobIds: string[];
}
