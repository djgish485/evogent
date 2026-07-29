'use client';

import { EVOGENT_NATIVE_BRIDGE_READY_EVENT } from '@/lib/overlay-screen-context';
import { useEffect, useState } from 'react';

interface EvogentHomeShell {
  openAndroidHome?: () => void;
}

function getEvogentHomeShell(): EvogentHomeShell | undefined {
  return (window as typeof window & {
    EvogentShell?: EvogentHomeShell;
  }).EvogentShell;
}

/**
 * The explicit switch from Evogent to the remembered stock Android HOME.
 *
 * Modern WebView providers install the native facade at document start. Older/degraded
 * providers install it only after the native host proves the loaded document, then emit the
 * readiness event below. Listening for both paths keeps the escape visible either way.
 */
export function AndroidHomeControl() {
  const [bridgeReady, setBridgeReady] = useState(false);

  useEffect(() => {
    const refreshBridgeReadiness = () => {
      setBridgeReady(
        typeof getEvogentHomeShell()?.openAndroidHome === 'function',
      );
    };

    window.addEventListener(
      EVOGENT_NATIVE_BRIDGE_READY_EVENT,
      refreshBridgeReadiness,
    );
    refreshBridgeReadiness();
    return () => {
      window.removeEventListener(
        EVOGENT_NATIVE_BRIDGE_READY_EVENT,
        refreshBridgeReadiness,
      );
    };
  }, []);

  if (!bridgeReady) return null;

  return (
    <>
      {/* Launcher switch — a system control, not a composer tool: filled, larger,
          and fenced off from the utility icons by a divider. */}
      <button
        type="button"
        onClick={() => getEvogentHomeShell()?.openAndroidHome?.()}
        data-testid="android-home-button"
        aria-label="Android home screen"
        className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-violet-600 text-white shadow-[0_2px_6px_rgba(0,0,0,0.4)] transition hover:bg-violet-500 active:scale-95"
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" className="h-[22px] w-[22px]">
          <path
            d="M12 3.1 3.8 10v9.4c0 .6.5 1.1 1.1 1.1h4.9v-6.3h4.4v6.3h4.9c.6 0 1.1-.5 1.1-1.1V10L12 3.1Z"
            className="fill-current"
          />
        </svg>
      </button>
      <div aria-hidden="true" className="mx-0.5 h-5 w-px shrink-0 bg-zinc-700/80" />
    </>
  );
}
