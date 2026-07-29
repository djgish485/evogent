export interface OverlayScreenContext {
  app: string | null;
  text: string;
}

export interface OverlayScreenContextPreview {
  label: string;
}

export interface OverlayScreenContextBridge {
  getScreenContext?: () => string;
}

export interface OverlayScreenContextHandoff {
  captureOnce: (readRawContext: () => string | null | undefined) => OverlayScreenContextPreview | null;
  clear: () => void;
  preview: () => OverlayScreenContextPreview | null;
  take: () => OverlayScreenContext | null;
}

export interface OverlayScreenContextHandoffOptions {
  now?: () => number;
  ttlMs?: number;
}

export const ASSISTANT_SCREEN_CONTEXT_TTL_MS = 5 * 60 * 1000;
export const EVOGENT_NATIVE_BRIDGE_READY_EVENT = 'evogent:native-bridge-ready';

function parseOverlayScreenContext(raw: string | null | undefined): OverlayScreenContext | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

    const candidate = parsed as { app?: unknown; text?: unknown };
    if (typeof candidate.text !== 'string') return null;

    const text = candidate.text.trim();
    if (text.length < 3) return null;

    const app = typeof candidate.app === 'string' && candidate.app.trim()
      ? candidate.app.trim()
      : null;
    return { app, text };
  } catch {
    return null;
  }
}

function getOverlayScreenContextPreview(context: OverlayScreenContext | null): OverlayScreenContextPreview | null {
  if (!context) return null;

  const normalizedApp = context.app?.toLowerCase() ?? '';
  const label = normalizedApp.includes('instagram')
    ? 'this Instagram post'
    : (normalizedApp.includes('twitter') || normalizedApp.includes('.x.'))
      ? 'this tweet'
      : 'this screen';
  return { label };
}

/**
 * Owns the native overlay bridge's one-shot value in page memory.
 *
 * `captureOnce` never calls the native reader more than once, including after the value is
 * consumed or abandoned. `preview` exposes only a non-sensitive display label. `take` atomically
 * clears the only retained raw value before returning it, so every possible consumer competes for
 * the same one-shot handoff. The age check is defense in depth for throttled browser timers; the
 * assistant page also calls `clear` on its active deadline, page hide, and visibility loss.
 */
export function createOverlayScreenContextHandoff(
  options: OverlayScreenContextHandoffOptions = {},
): OverlayScreenContextHandoff {
  const now = options.now ?? Date.now;
  const ttlMs = Number.isFinite(options.ttlMs) && Number(options.ttlMs) > 0
    ? Number(options.ttlMs)
    : ASSISTANT_SCREEN_CONTEXT_TTL_MS;
  let didCapture = false;
  let context: OverlayScreenContext | null = null;
  let capturedAtMs: number | null = null;

  const clear = () => {
    // Clearing is terminal for this explicit assistant invocation. A late fallback-bridge event
    // must never reacquire screen content after the user hid or abandoned the surface.
    didCapture = true;
    context = null;
    capturedAtMs = null;
  };

  const liveContext = () => {
    if (
      context
      && capturedAtMs !== null
      && Math.max(0, now() - capturedAtMs) >= ttlMs
    ) {
      clear();
    }
    return context;
  };

  return {
    captureOnce(readRawContext) {
      if (didCapture) return getOverlayScreenContextPreview(liveContext());
      didCapture = true;
      try {
        context = parseOverlayScreenContext(readRawContext());
        capturedAtMs = context ? now() : null;
      } catch {
        context = null;
        capturedAtMs = null;
      }
      return getOverlayScreenContextPreview(context);
    },
    clear,
    preview() {
      return getOverlayScreenContextPreview(liveContext());
    },
    take() {
      const captured = liveContext();
      context = null;
      capturedAtMs = null;
      return captured;
    },
  };
}

/**
 * A missing bridge is not a capture attempt. This distinction lets a post-proof fallback facade
 * announce readiness without weakening one-shot handling for a bridge that was present but failed.
 */
export function captureOverlayScreenContextFromBridge(
  handoff: OverlayScreenContextHandoff,
  bridge: OverlayScreenContextBridge | null | undefined,
): OverlayScreenContextPreview | null | undefined {
  if (typeof bridge?.getScreenContext !== 'function') return undefined;
  return handoff.captureOnce(() => bridge.getScreenContext?.());
}
