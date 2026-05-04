const MIN_INTERVAL_MINUTES = 60;
const MAX_INTERVAL_MINUTES = 360;
const PREDICTIVE_LEAD_MINUTES = 30;
const RECENT_EVENT_WINDOW_MINUTES = 20;
const INACTIVITY_BACKOFF_AFTER_MINUTES = 24 * 60;
const INACTIVITY_BACKOFF_MAX_MULTIPLIER = 4;

const ACTIVITY_WEIGHTS = Object.freeze({
  app_open: 2,
  pull_refresh: 3,
  ping: 2,
  foreground: 2,
  background: 1,
});

function toDate(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value !== 'string') return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function minutesBetween(left, right) {
  return Math.floor((left.getTime() - right.getTime()) / 60000);
}

function normalizeActivities(activityHistory) {
  if (!Array.isArray(activityHistory)) return [];

  return activityHistory
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const event = typeof entry.event === 'string' ? entry.event : '';
      const timestamp = toDate(entry.timestamp);
      if (!event || !timestamp) return null;
      return {
        event,
        timestamp,
      };
    })
    .filter((entry) => entry !== null)
    .sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
}

function findPeakHours(hourCounts) {
  const maxCount = Math.max(...hourCounts);
  if (maxCount <= 0) return [];

  const threshold = Math.max(2, Math.ceil(maxCount * 0.55));
  const ranked = hourCounts
    .map((count, hour) => ({ hour, count }))
    .filter((row) => row.count >= threshold)
    .sort((left, right) => {
      if (right.count !== left.count) return right.count - left.count;
      return left.hour - right.hour;
    })
    .slice(0, 4)
    .map((row) => row.hour);

  if (ranked.length > 0) return ranked;

  return hourCounts
    .map((count, hour) => ({ hour, count }))
    .filter((row) => row.count > 0)
    .sort((left, right) => {
      if (right.count !== left.count) return right.count - left.count;
      return left.hour - right.hour;
    })
    .slice(0, 3)
    .map((row) => row.hour);
}

function buildPeakWindows(dayHourCounts) {
  const flattened = [];

  for (let day = 0; day < 7; day += 1) {
    for (let hour = 0; hour < 24; hour += 1) {
      const count = dayHourCounts[day][hour];
      if (count > 0) {
        flattened.push({ dayOfWeek: day, hour, score: count });
      }
    }
  }

  if (flattened.length === 0) return [];

  const maxScore = Math.max(...flattened.map((row) => row.score));
  const minScore = Math.max(2, Math.ceil(maxScore * 0.5));

  return flattened
    .filter((row) => row.score >= minScore)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (left.dayOfWeek !== right.dayOfWeek) return left.dayOfWeek - right.dayOfWeek;
      return left.hour - right.hour;
    })
    .slice(0, 10);
}

function nextOccurrenceForWindow(now, window) {
  const base = new Date(now.getTime());
  base.setUTCSeconds(0, 0);
  base.setUTCMinutes(0);
  base.setUTCHours(window.hour);

  const dayDiff = (window.dayOfWeek - now.getUTCDay() + 7) % 7;
  base.setUTCDate(base.getUTCDate() + dayDiff);

  if (base.getTime() <= now.getTime()) {
    base.setUTCDate(base.getUTCDate() + 7);
  }

  return base;
}

function nextOccurrenceForHour(now, hour) {
  const candidate = new Date(now.getTime());
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(0);
  candidate.setUTCHours(hour);
  if (candidate.getTime() <= now.getTime()) {
    candidate.setUTCDate(candidate.getUTCDate() + 1);
  }
  return candidate;
}

function findNewestEvent(events) {
  if (events.length === 0) return null;
  const newest = events[events.length - 1];
  return {
    event: newest.event,
    timestamp: newest.timestamp.toISOString(),
  };
}

function normalizeRecentAutomatedCancellation(value) {
  if (!value || typeof value !== 'object') return null;
  const cancelledAt = toDate(value.cancelledAt);
  if (!cancelledAt) return null;

  return {
    requestId: typeof value.requestId === 'string' && value.requestId.trim()
      ? value.requestId.trim()
      : null,
    cancelledAt,
    triggeredBy: typeof value.triggeredBy === 'string' && value.triggeredBy.trim()
      ? value.triggeredBy.trim()
      : null,
    cancellationReason: typeof value.cancellationReason === 'string' && value.cancellationReason.trim()
      ? value.cancellationReason.trim()
      : null,
  };
}

function resolveInactivityBackoffInterval(maxIntervalMinutes, latestActivityAge) {
  if (!Number.isFinite(latestActivityAge) || latestActivityAge <= INACTIVITY_BACKOFF_AFTER_MINUTES) {
    return maxIntervalMinutes;
  }

  const inactiveDays = Math.max(1, Math.floor(latestActivityAge / (24 * 60)));
  const multiplier = Math.min(
    INACTIVITY_BACKOFF_MAX_MULTIPLIER,
    Math.max(2, inactiveDays),
  );
  return maxIntervalMinutes * multiplier;
}

function resolveNextUsageWindow(now, analysis) {
  const fromWindows = analysis.peakWindows
    .map((window) => {
      const at = nextOccurrenceForWindow(now, window);
      return {
        dayOfWeek: window.dayOfWeek,
        hour: window.hour,
        score: window.score,
        at,
      };
    })
    .sort((left, right) => {
      if (left.at.getTime() !== right.at.getTime()) {
        return left.at.getTime() - right.at.getTime();
      }
      return right.score - left.score;
    })[0];

  if (fromWindows) {
    return {
      ...fromWindows,
      source: 'day_hour_window',
    };
  }

  const fromHours = analysis.peakHours
    .map((hour) => ({
      dayOfWeek: null,
      hour,
      score: analysis.hourlyCounts[hour] || 0,
      at: nextOccurrenceForHour(now, hour),
      source: 'hour_window',
    }))
    .sort((left, right) => left.at.getTime() - right.at.getTime())[0];

  return fromHours || null;
}

function analyzePatterns(activityHistory) {
  const normalized = normalizeActivities(activityHistory);
  const hourlyCounts = Array.from({ length: 24 }, () => 0);
  const dayOfWeekHourlyCounts = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));

  for (const activity of normalized) {
    const hour = activity.timestamp.getUTCHours();
    const dayOfWeek = activity.timestamp.getUTCDay();
    const weight = ACTIVITY_WEIGHTS[activity.event] || 1;
    hourlyCounts[hour] += weight;
    dayOfWeekHourlyCounts[dayOfWeek][hour] += weight;
  }

  return {
    sampleSize: normalized.length,
    hourlyCounts,
    dayOfWeekHourlyCounts,
    peakHours: findPeakHours(hourlyCounts),
    peakWindows: buildPeakWindows(dayOfWeekHourlyCounts),
    mostRecentActivity: findNewestEvent(normalized),
  };
}

function shouldTrigger(input) {
  const decision = getTriggerDecision(input);
  return decision.trigger;
}

function getTriggerDecision(input) {
  const now = toDate(input?.now) || new Date();
  const analysis = analyzePatterns(input?.activityHistory || []);
  const minIntervalMinutes = Number.isFinite(input?.minIntervalMinutes)
    ? Math.max(1, Math.floor(input.minIntervalMinutes))
    : MIN_INTERVAL_MINUTES;
  const maxIntervalMinutes = Number.isFinite(input?.maxIntervalMinutes)
    ? Math.max(minIntervalMinutes, Math.floor(input.maxIntervalMinutes))
    : MAX_INTERVAL_MINUTES;
  const leadMinutes = Number.isFinite(input?.predictiveLeadMinutes)
    ? Math.max(0, Math.floor(input.predictiveLeadMinutes))
    : PREDICTIVE_LEAD_MINUTES;

  const lastCurationAtDate = toDate(input?.lastCurationAt || null);
  const minutesSinceLastCuration = lastCurationAtDate
    ? minutesBetween(now, lastCurationAtDate)
    : Number.POSITIVE_INFINITY;

  if (minutesSinceLastCuration < minIntervalMinutes) {
    return {
      trigger: false,
      reason: 'min_interval_not_elapsed',
      minutesSinceLastCuration,
      minIntervalMinutes,
      maxIntervalMinutes,
      predictedWindow: null,
      analysis,
    };
  }

  const latestActivityRaw = input?.latestActivity && typeof input.latestActivity === 'object'
    ? input.latestActivity
    : analysis.mostRecentActivity;
  const latestActivity = latestActivityRaw && typeof latestActivityRaw.event === 'string'
    ? {
      event: latestActivityRaw.event,
      timestamp: typeof latestActivityRaw.timestamp === 'string' ? latestActivityRaw.timestamp : '',
    }
    : null;
  const latestActivityAt = latestActivity ? toDate(latestActivity.timestamp) : null;
  const latestActivityAge = latestActivityAt ? minutesBetween(now, latestActivityAt) : Number.POSITIVE_INFINITY;
  const recentAutomatedCancellation = normalizeRecentAutomatedCancellation(input?.recentAutomatedCancellation);
  const cancellationCooldownMinutes = Number.isFinite(input?.automaticCancellationCooldownMinutes)
    ? Math.max(RECENT_EVENT_WINDOW_MINUTES, Math.floor(input.automaticCancellationCooldownMinutes))
    : Math.max(RECENT_EVENT_WINDOW_MINUTES, minIntervalMinutes);

  if (recentAutomatedCancellation) {
    const cancellationResetBySuccessfulCuration = lastCurationAtDate
      ? lastCurationAtDate.getTime() > recentAutomatedCancellation.cancelledAt.getTime()
      : false;
    const minutesSinceCancellation = minutesBetween(now, recentAutomatedCancellation.cancelledAt);

    if (!cancellationResetBySuccessfulCuration && minutesSinceCancellation < cancellationCooldownMinutes) {
      return {
        trigger: false,
        reason: 'user_cancel_cooldown_active',
        minutesSinceLastCuration,
        minIntervalMinutes,
        maxIntervalMinutes,
        predictedWindow: null,
        analysis,
        recentAutomatedCancellation: {
          requestId: recentAutomatedCancellation.requestId,
          cancelledAt: recentAutomatedCancellation.cancelledAt.toISOString(),
          triggeredBy: recentAutomatedCancellation.triggeredBy,
          cancellationReason: recentAutomatedCancellation.cancellationReason,
          minutesSinceCancellation,
          cooldownMinutes: cancellationCooldownMinutes,
        },
      };
    }
  }

  if (latestActivity && latestActivity.event === 'pull_refresh' && minutesSinceLastCuration >= 60 && latestActivityAge <= RECENT_EVENT_WINDOW_MINUTES) {
    return {
      trigger: true,
      reason: 'pull_refresh_immediate',
      minutesSinceLastCuration,
      minIntervalMinutes,
      maxIntervalMinutes,
      predictedWindow: null,
      analysis,
    };
  }

  if (latestActivity && latestActivity.event === 'app_open' && latestActivityAge <= RECENT_EVENT_WINDOW_MINUTES) {
    return {
      trigger: true,
      reason: 'app_open_auto',
      minutesSinceLastCuration,
      minIntervalMinutes,
      maxIntervalMinutes,
      predictedWindow: null,
      analysis,
    };
  }

  const nextWindow = resolveNextUsageWindow(now, analysis);
  const predictedWindow = nextWindow
    ? {
      source: nextWindow.source,
      dayOfWeek: nextWindow.dayOfWeek,
      hour: nextWindow.hour,
      score: nextWindow.score,
      at: nextWindow.at.toISOString(),
      minutesUntilWindow: minutesBetween(nextWindow.at, now),
    }
    : null;

  if (predictedWindow && predictedWindow.minutesUntilWindow >= 0 && predictedWindow.minutesUntilWindow <= leadMinutes) {
    return {
      trigger: true,
      reason: 'predicted_usage_window',
      minutesSinceLastCuration,
      minIntervalMinutes,
      maxIntervalMinutes,
      predictedWindow,
      analysis,
    };
  }

  const inactivityBackoffIntervalMinutes = resolveInactivityBackoffInterval(maxIntervalMinutes, latestActivityAge);

  if (minutesSinceLastCuration >= maxIntervalMinutes) {
    if (
      inactivityBackoffIntervalMinutes > maxIntervalMinutes
      && minutesSinceLastCuration < inactivityBackoffIntervalMinutes
    ) {
      return {
        trigger: false,
        reason: 'inactivity_backoff_active',
        minutesSinceLastCuration,
        minIntervalMinutes,
        maxIntervalMinutes,
        predictedWindow,
        analysis,
        inactivityBackoffIntervalMinutes,
      };
    }

    return {
      trigger: true,
      reason: 'max_interval_elapsed',
      minutesSinceLastCuration,
      minIntervalMinutes,
      maxIntervalMinutes,
      predictedWindow,
      analysis,
      inactivityBackoffIntervalMinutes,
    };
  }

  return {
    trigger: false,
    reason: 'no_trigger_rule_matched',
    minutesSinceLastCuration,
    minIntervalMinutes,
    maxIntervalMinutes,
    predictedWindow,
    analysis,
  };
}

module.exports = {
  MIN_INTERVAL_MINUTES,
  MAX_INTERVAL_MINUTES,
  PREDICTIVE_LEAD_MINUTES,
  analyzePatterns,
  shouldTrigger,
  getTriggerDecision,
};
