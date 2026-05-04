'use client';

import { useState, useSyncExternalStore } from 'react';

interface SetupBannerProps {
  isStarting?: boolean;
  isSetupReady?: boolean;
  onStartSetup: () => void | Promise<void>;
}

export const SETUP_BANNER_DISMISSED_STORAGE_KEY = 'evogent.setup-banner.dismissed.v2';

function readSetupBannerDismissed(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  try {
    return window.localStorage.getItem(SETUP_BANNER_DISMISSED_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function writeSetupBannerDismissed(): void {
  try {
    window.localStorage.setItem(SETUP_BANNER_DISMISSED_STORAGE_KEY, 'true');
  } catch {
    // Local storage can be unavailable in restricted browser contexts.
  }
}

function subscribeSetupBannerDismissed(onStoreChange: () => void): () => void {
  if (typeof window === 'undefined') {
    return () => {};
  }

  window.addEventListener('storage', onStoreChange);
  return () => window.removeEventListener('storage', onStoreChange);
}

export function SetupBanner({
  isStarting = false,
  isSetupReady = false,
  onStartSetup,
}: SetupBannerProps) {
  const storedDismissed = useSyncExternalStore(
    subscribeSetupBannerDismissed,
    readSetupBannerDismissed,
    () => false,
  );
  const [clickedDismissed, setClickedDismissed] = useState(false);
  const dismissed = storedDismissed || clickedDismissed;

  if (isSetupReady || dismissed) {
    return null;
  }

  function handleStartSetup() {
    setClickedDismissed(true);
    writeSetupBannerDismissed();
    void onStartSetup();
  }

  return (
    <div
      data-testid="setup-banner"
      className="rounded-2xl border border-sky-500/20 bg-gradient-to-r from-sky-500/10 via-blue-500/10 to-indigo-500/10 px-4 py-3 shadow-[0_10px_30px_rgba(37,99,235,0.08)]"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-200/80">Welcome</p>
          <p className="mt-1 text-sm font-medium text-zinc-100">
            Add sources for the Curator Agent to work with.
          </p>
        </div>
        <button
          type="button"
          onClick={handleStartSetup}
          disabled={isStarting}
          data-testid="setup-banner-start-chat"
          className="inline-flex min-h-11 items-center justify-center rounded-full border border-sky-400/35 bg-sky-500/12 px-4 py-2 text-sm font-medium text-sky-100 transition hover:border-sky-300/55 hover:bg-sky-500/20"
        >
          {isStarting ? 'Starting...' : 'Finish Setup'}
        </button>
      </div>
    </div>
  );
}
