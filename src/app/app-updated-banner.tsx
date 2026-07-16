'use client';

import { useEffect, useRef, useState } from 'react';
import { RECONNECTING_WS_RECONNECTED_EVENT } from '@/lib/reconnecting-ws';

async function fetchBuildId() {
  const response = await fetch('/api/status', { cache: 'no-store' });
  if (!response.ok) return null;
  const payload = await response.json() as { deployment?: { running?: { buildId?: string | null } } };
  return payload.deployment?.running?.buildId ?? null;
}

export function AppUpdatedBanner() {
  const initialBuildIdRef = useRef<string | null | undefined>(undefined);
  const updatePendingRef = useRef(false);
  const [showBanner, setShowBanner] = useState(false);

  useEffect(() => {
    let active = true;
    const loadInitialBuildId = async () => {
      initialBuildIdRef.current = await fetchBuildId().catch(() => null);
    };
    const checkForUpdate = async () => {
      const nextBuildId = await fetchBuildId().catch(() => null);
      if (!active || initialBuildIdRef.current === undefined || !initialBuildIdRef.current || !nextBuildId) return;
      if (initialBuildIdRef.current !== nextBuildId) {
        updatePendingRef.current = true;
        setShowBanner(true);
      }
    };

    // Auto-reload the moment the page is backgrounded (screen off, app switch, home). The shell
    // is force-dynamic so a reload pulls the new build; doing it while hidden means the user (and
    // the on-glass verification loop) never sees a stale feed and never has to tap the banner —
    // Evogent is simply fresh the next time it's looked at. The manual button stays as a fallback
    // for anyone who wants it now.
    const onVisibility = () => {
      if (updatePendingRef.current && document.visibilityState === 'hidden') {
        window.location.reload();
      }
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
