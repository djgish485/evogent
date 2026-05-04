import heartbeatCore from './heartbeat-core.js';

export const MIN_INTERVAL_MINUTES = heartbeatCore.MIN_INTERVAL_MINUTES as number;
export const MAX_INTERVAL_MINUTES = heartbeatCore.MAX_INTERVAL_MINUTES as number;
export const PREDICTIVE_LEAD_MINUTES = heartbeatCore.PREDICTIVE_LEAD_MINUTES as number;

export type ActivityEvent = 'app_open' | 'pull_refresh' | 'ping' | 'foreground' | 'background';

export interface ActivitySample {
  event: ActivityEvent | string;
  timestamp: string;
}

export interface PeakWindow {
  dayOfWeek: number;
  hour: number;
  score: number;
}

export interface PatternAnalysis {
  sampleSize: number;
  hourlyCounts: number[];
  dayOfWeekHourlyCounts: number[][];
  peakHours: number[];
  peakWindows: PeakWindow[];
  mostRecentActivity: ActivitySample | null;
}

export interface PredictedWindow {
  source: 'day_hour_window' | 'hour_window';
  dayOfWeek: number | null;
  hour: number;
  score: number;
  at: string;
  minutesUntilWindow: number;
}

export interface TriggerDecision {
  trigger: boolean;
  reason: string;
  minutesSinceLastCuration: number;
  minIntervalMinutes: number;
  maxIntervalMinutes: number;
  predictedWindow: PredictedWindow | null;
  analysis: PatternAnalysis;
  recentAutomatedCancellation?: {
    requestId: string | null;
    cancelledAt: string;
    triggeredBy: string | null;
    cancellationReason: string | null;
    minutesSinceCancellation: number;
    cooldownMinutes: number;
  };
  inactivityBackoffIntervalMinutes?: number;
}

export interface ShouldTriggerInput {
  now?: Date | string;
  activityHistory: ActivitySample[];
  latestActivity?: ActivitySample | null;
  lastCurationAt: string | null;
  minIntervalMinutes?: number;
  maxIntervalMinutes?: number;
  predictiveLeadMinutes?: number;
  recentAutomatedCancellation?: {
    requestId?: string | null;
    cancelledAt: string;
    triggeredBy?: string | null;
    cancellationReason?: string | null;
  } | null;
  automaticCancellationCooldownMinutes?: number;
}

export function analyzePatterns(activityHistory: ActivitySample[]): PatternAnalysis {
  return heartbeatCore.analyzePatterns(activityHistory) as PatternAnalysis;
}

export function getTriggerDecision(input: ShouldTriggerInput): TriggerDecision {
  return heartbeatCore.getTriggerDecision(input) as TriggerDecision;
}

export function shouldTrigger(input: ShouldTriggerInput): boolean {
  return heartbeatCore.shouldTrigger(input) as boolean;
}
