import { type FeedSourceOption } from '@/lib/feed-filters';

export type ActivityEvent = 'app_open' | 'ping' | 'foreground' | 'background';

export type SetupReadinessResponse = {
  setupReady?: boolean;
  required?: string[];
};

export type SetupReadinessRequirement = NonNullable<SetupReadinessResponse['required']>[number];

export type SetupReadinessStatus = {
  setupReady: boolean;
  required: SetupReadinessRequirement[];
};

export interface SkillsApiResponse {
  feedSources?: FeedSourceOption[];
}

export type SkillsFeedSource = NonNullable<SkillsApiResponse['feedSources']>[number];

export function normalizeSetupReadinessResponse(response: SetupReadinessResponse | null | undefined): SetupReadinessStatus {
  return {
    setupReady: response?.setupReady === true,
    required: response?.required ?? [],
  };
}
