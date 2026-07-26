export interface ScrollGeometry {
  scrollTop: number;
  viewportHeight: number;
  scrollHeight: number;
}

export interface ActiveDwellTracker {
  resume: () => void;
  pause: () => number;
  read: () => number;
}

export interface ScrollDepthTracker {
  observe: (input: ScrollGeometry) => number;
  read: () => number;
}

export interface UserScrollEvidenceTracker {
  noteIntent: (scrollTop: number) => void;
  observe: (scrollTop: number) => boolean;
  clearIntent: () => void;
  read: () => boolean;
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/**
 * Measures the furthest part of a detail view the reader could actually see. A short document
 * that fits in the viewport is truthfully 100% visible; a long document begins at the fraction
 * visible above the fold and only increases as the reader scrolls.
 */
export function calculateScrollDepthPercent(input: ScrollGeometry): number {
  const scrollHeight = finiteNonNegative(input.scrollHeight);
  if (scrollHeight === 0) return 0;

  const viewportHeight = finiteNonNegative(input.viewportHeight);
  const scrollTop = finiteNonNegative(input.scrollTop);
  const visibleBottom = Math.min(scrollHeight, scrollTop + viewportHeight);
  return Math.min(100, Math.max(0, Math.round((visibleBottom / scrollHeight) * 100)));
}

/**
 * Retains the furthest visible point in pixels while also retaining the largest document height
 * observed. That makes the measurement conservative when enrichment adds content after opening:
 * an initially short loading shell cannot permanently claim 100% depth for the final article.
 */
export function createScrollDepthTracker(): ScrollDepthTracker {
  let furthestVisibleBottom = 0;
  let largestScrollHeight = 0;

  const read = () => {
    if (largestScrollHeight <= 0) return 0;
    return Math.min(100, Math.max(0, Math.round((furthestVisibleBottom / largestScrollHeight) * 100)));
  };

  return {
    observe(input) {
      const scrollHeight = finiteNonNegative(input.scrollHeight);
      const viewportHeight = finiteNonNegative(input.viewportHeight);
      const scrollTop = finiteNonNegative(input.scrollTop);
      largestScrollHeight = Math.max(largestScrollHeight, scrollHeight);
      furthestVisibleBottom = Math.max(
        furthestVisibleBottom,
        Math.min(scrollHeight, scrollTop + viewportHeight),
      );
      return read();
    },
    read,
  };
}

/**
 * Distinguishes a deliberate reading gesture from layout restoration or another programmatic
 * scroll. Intent alone is insufficient: the viewport must then move a meaningful distance.
 */
export function createUserScrollEvidenceTracker(
  minimumMovementPx = 24,
  now: () => number = () => Date.now(),
  intentWindowMs = 1_500,
): UserScrollEvidenceTracker {
  const threshold = Math.max(1, finiteNonNegative(minimumMovementPx));
  const maximumIntentAgeMs = Math.max(1, finiteNonNegative(intentWindowMs));
  let intentOrigin: number | null = null;
  let intentStartedAtMs: number | null = null;
  let userScrolled = false;

  return {
    noteIntent(scrollTop) {
      if (userScrolled) return;
      intentOrigin = finiteNonNegative(scrollTop);
      intentStartedAtMs = now();
    },
    observe(scrollTop) {
      if (
        intentStartedAtMs !== null
        && now() - intentStartedAtMs > maximumIntentAgeMs
      ) {
        intentOrigin = null;
        intentStartedAtMs = null;
      }
      if (
        !userScrolled
        && intentOrigin !== null
        && Math.abs(finiteNonNegative(scrollTop) - intentOrigin) >= threshold
      ) {
        userScrolled = true;
        intentOrigin = null;
        intentStartedAtMs = null;
      }
      return userScrolled;
    },
    clearIntent() {
      intentOrigin = null;
      intentStartedAtMs = null;
    },
    read() {
      return userScrolled;
    },
  };
}

/**
 * Counts active foreground time only. Callers pause this clock when the document becomes hidden,
 * so app switching and a sleeping phone do not inflate dwell.
 */
export function createActiveDwellTracker(now: () => number): ActiveDwellTracker {
  let accumulatedMs = 0;
  let activeSinceMs: number | null = null;

  const read = () => {
    const activeDelta = activeSinceMs === null
      ? 0
      : Math.max(0, now() - activeSinceMs);
    return Math.max(0, Math.round(accumulatedMs + activeDelta));
  };

  return {
    resume() {
      if (activeSinceMs === null) {
        activeSinceMs = now();
      }
    },
    pause() {
      if (activeSinceMs !== null) {
        accumulatedMs += Math.max(0, now() - activeSinceMs);
        activeSinceMs = null;
      }
      return Math.max(0, Math.round(accumulatedMs));
    },
    read,
  };
}

export function createFeedEngagementSessionId(feedItemId: string): string {
  const safeItemId = feedItemId.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 40) || 'item';
  const randomPart = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `detail:${safeItemId}:${randomPart}`.slice(0, 128);
}
