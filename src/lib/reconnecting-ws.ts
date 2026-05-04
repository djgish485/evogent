export interface ReconnectingWsOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  onReconnect?: () => void;
}

export const RECONNECTING_WS_RECONNECTED_EVENT = 'evogent:ws-reconnected';

export function createReconnectingWs(
  url: string,
  onMessage: (event: MessageEvent) => void,
  options?: ReconnectingWsOptions,
): () => void {
  const { maxRetries = Number.POSITIVE_INFINITY, baseDelayMs = 1000, maxDelayMs = 30000, onReconnect } = options ?? {};
  let ws: WebSocket | null = null;
  let retryCount = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let hasConnectedOnce = false;

  const connect = () => {
    if (disposed) return;

    ws = new WebSocket(url);

    ws.onopen = () => {
      const wasReconnect = hasConnectedOnce;
      hasConnectedOnce = true;
      retryCount = 0;
      if (wasReconnect && onReconnect) {
        onReconnect();
      }
      if (wasReconnect && typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent(RECONNECTING_WS_RECONNECTED_EVENT, {
          detail: { url },
        }));
      }
    };

    ws.onmessage = onMessage;

    ws.onclose = () => {
      ws = null;
      if (disposed) return;
      if (retryCount >= maxRetries) return;

      const delay = Math.min(baseDelayMs * (2 ** retryCount), maxDelayMs);
      retryCount += 1;
      timer = setTimeout(() => {
        timer = null;
        connect();
      }, delay);
    };

    ws.onerror = () => {
      // onclose handles reconnect scheduling.
    };
  };

  connect();

  return () => {
    disposed = true;

    if (timer) {
      clearTimeout(timer);
      timer = null;
    }

    if (ws) {
      ws.onclose = null;
      ws.close();
      ws = null;
    }
  };
}
