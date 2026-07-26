/**
 * Open-aware cycle scheduling: predict when the user will next open the feed from their
 * recorded open history, so the browse+curate cycle can finish shortly before
 * that moment and each likely arrival lands on fresh content.
 *
 * The model is deliberately simple and explainable: coalesce opens into session starts,
 * build an hour-of-day profile (on how many observed days did a session start in hour h?),
 * and pick the next upcoming hour whose historical open probability clears a threshold.
 * With only a couple of days of history the profile is coarse but still beats a fixed
 * interval; it sharpens automatically as user_activity accrues.
 */

export interface NextOpenPrediction {
  predictedOpenAtMs: number | null;
  basis: {
    daysObserved: number;
    sessionStarts: number;
    chosenHour: number | null;
    chosenHourProbability: number | null;
    medianMinuteInHour: number | null;
    fallback: 'none' | 'median-gap' | 'no-history';
  };
}

const SESSION_COALESCE_MS = 30 * 60 * 1000;
const PROFILE_THRESHOLD = 0.5;
const MIN_LEAD_FROM_NOW_MS = 5 * 60 * 1000;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Coalesce raw open/foreground events into session starts (first event after a 30min+ gap). */
export function toSessionStarts(openTimestampsMs: number[]): number[] {
  const sorted = [...openTimestampsMs].sort((left, right) => left - right);
  const starts: number[] = [];
  let lastKept = -Infinity;
  for (const ts of sorted) {
    if (ts - lastKept > SESSION_COALESCE_MS) {
      starts.push(ts);
    }
    lastKept = ts;
  }
  return starts;
}

function localDayKey(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function predictNextOpen(nowMs: number, openTimestampsMs: number[]): NextOpenPrediction {
  const starts = toSessionStarts(openTimestampsMs);
  if (starts.length === 0) {
    return {
      predictedOpenAtMs: null,
      basis: { daysObserved: 0, sessionStarts: 0, chosenHour: null, chosenHourProbability: null, medianMinuteInHour: null, fallback: 'no-history' },
    };
  }

  const dayKeys = new Set<string>();
  const daysWithStartInHour = new Map<number, Set<string>>();
  const minutesByHour = new Map<number, number[]>();
  for (const ts of starts) {
    const date = new Date(ts);
    const hour = date.getHours();
    const day = localDayKey(ts);
    dayKeys.add(day);
    const hourDays = daysWithStartInHour.get(hour) ?? new Set<string>();
    hourDays.add(day);
    daysWithStartInHour.set(hour, hourDays);
    const minutes = minutesByHour.get(hour) ?? [];
    minutes.push(date.getMinutes());
    minutesByHour.set(hour, minutes);
  }
  const daysObserved = Math.max(1, dayKeys.size);

  // Scan the next 24 hours for the first hour that clears the threshold; remember the best
  // sub-threshold hour as a backup so thin history still yields a prediction.
  const earliestAllowed = nowMs + MIN_LEAD_FROM_NOW_MS;
  let best: { openAtMs: number; hour: number; probability: number; medianMinute: number } | null = null;
  for (let offset = 0; offset <= 24; offset += 1) {
    const hourStart = new Date(nowMs);
    hourStart.setMinutes(0, 0, 0);
    const candidateStartMs = hourStart.getTime() + offset * 60 * 60 * 1000;
    const hour = new Date(candidateStartMs).getHours();
    const probability = (daysWithStartInHour.get(hour)?.size ?? 0) / daysObserved;
    if (probability <= 0) continue;
    const medianMinute = median(minutesByHour.get(hour) ?? []) ?? 0;
    const openAtMs = candidateStartMs + medianMinute * 60 * 1000;
    if (openAtMs < earliestAllowed) continue;
    if (probability >= PROFILE_THRESHOLD) {
      return {
        predictedOpenAtMs: openAtMs,
        basis: { daysObserved, sessionStarts: starts.length, chosenHour: hour, chosenHourProbability: probability, medianMinuteInHour: medianMinute, fallback: 'none' },
      };
    }
    if (!best || probability > best.probability) {
      best = { openAtMs, hour, probability, medianMinute };
    }
  }

  if (best) {
    return {
      predictedOpenAtMs: best.openAtMs,
      basis: { daysObserved, sessionStarts: starts.length, chosenHour: best.hour, chosenHourProbability: best.probability, medianMinuteInHour: best.medianMinute, fallback: 'none' },
    };
  }

  // No hour profile ahead (shouldn't happen with any history) — median inter-session gap.
  const gaps: number[] = [];
  for (let index = 1; index < starts.length; index += 1) {
    gaps.push(starts[index] - starts[index - 1]);
  }
  const gap = median(gaps);
  return {
    predictedOpenAtMs: gap ? Math.max(earliestAllowed, starts[starts.length - 1] + gap) : null,
    basis: { daysObserved, sessionStarts: starts.length, chosenHour: null, chosenHourProbability: null, medianMinuteInHour: null, fallback: gap ? 'median-gap' : 'no-history' },
  };
}
