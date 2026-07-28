export interface OverlayScreenContext {
  app: string | null;
  text: string;
}

export interface OverlayScreenContextPreview {
  label: string;
}

export interface OverlayScreenContextHandoff {
  captureOnce: (readRawContext: () => string | null | undefined) => OverlayScreenContextPreview | null;
  preview: () => OverlayScreenContextPreview | null;
  take: () => OverlayScreenContext | null;
}

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
 * consumed. `preview` exposes only a non-sensitive display label. `take` atomically clears the
 * only retained raw value before returning it, so every possible consumer competes for the same
 * one-shot handoff.
 */
export function createOverlayScreenContextHandoff(): OverlayScreenContextHandoff {
  let didCapture = false;
  let context: OverlayScreenContext | null = null;

  return {
    captureOnce(readRawContext) {
      if (didCapture) return getOverlayScreenContextPreview(context);
      didCapture = true;
      try {
        context = parseOverlayScreenContext(readRawContext());
      } catch {
        context = null;
      }
      return getOverlayScreenContextPreview(context);
    },
    preview() {
      return getOverlayScreenContextPreview(context);
    },
    take() {
      const captured = context;
      context = null;
      return captured;
    },
  };
}
