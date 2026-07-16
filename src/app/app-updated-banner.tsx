'use client';

import { useEffect, useRef, useState } from 'react';
import { RECONNECTING_WS_RECONNECTED_EVENT } from '@/lib/reconnecting-ws';

async function fetchBuildId() {
  const response = await fetch('/api/status', { cache: 'no-store' });
  if (!response.ok) return null;
  const payload = await response.json() as { deployment?: { running?: { buildId?: string | null } } };
  return payload.deployment?.running?.buildId ?? null;
}

const CHECK_THROTTLE_MS = 60_000;

export function AppUpdatedBanner() {
  const initialBuildIdRef = useRef<string | null | undefined>(undefined);
  const updatePendingRef = useRef(false);
  const lastCheckAtRef = useRef(0);
  const [showBanner, setShowBanner] = useState(false);

  useEffect(() => {
    let active = true;
    const loadInitialBuildId = async () => {
      initialBuildIdRef.current = await fetchBuildId().catch(() => null);
    };
    const checkForUpdate = async () => {
      // One check per minute is plenty: all four websockets reconnect together after a server
      // restart, and every app foreground also lands here.
      const now = Date.now();
      if (now - lastCheckAtRef.current < CHECK_THROTTLE_MS) return;
      lastCheckAtRef.current = now;
      const nextBuildId = await fetchBuildId().catch(() => null);
      if (!active || initialBuildIdRef.current === undefined || !initialBuildIdRef.current || !nextBuildId) return;
      if (initialBuildIdRef.current !== nextBuildId) {
        updatePendingRef.current = true;
        setShowBanner(true);
      }
    };

    // Update lifecycle: detect a new build on websocket reconnect (a deploy restarts the
    // server, dropping every socket) AND on each foreground (throttled), then apply it by
    // reloading the moment the page is next hidden — never while the user is looking at it.
    // The feed's resume state (saved on hide/pagehide, restored on boot) puts them back at
    // the exact card they were reading, so the reload is invisible. The banner stays as a
    // manual reload-now affordance for a user who wants the update while staying in the app.
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        if (updatePendingRef.current) window.location.reload();
        return;
      }
      void checkForUpdate();
    };

    void loadInitialBuildId();
    window.addEventListener(RECONNECTING_WS_RECONNECTED_EVENT, checkForUpdate);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      active = false;
      window.removeEventListener(RECONNECTING_WS_RECONNECTED_EVENT, checkForUpdate);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  if (!showBanner) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[80] flex justify-center px-4 pt-[max(0.75rem,env(safe-area-inset-top))]">
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="pointer-events-auto rounded-full border border-blue-400/40 bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-lg transition hover:bg-blue-500 active:bg-blue-700"
      >
        App updated — tap to reload.
      </button>
    </div>
  );
}
