'use client';

import { useEffect, useState } from 'react';
import {
  detectPwaInstallEnvironment,
  isDismissedWithinWindow,
  isStandaloneDisplayMode,
  PWA_INSTALL_BANNER_DISMISSED_STORAGE_KEY,
} from './install-environment';

interface BeforeInstallPromptChoice {
  outcome: 'accepted' | 'dismissed';
  platform: string;
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<BeforeInstallPromptChoice>;
}

type PwaInstallBannerMode = 'ios' | 'install';

let sessionDismissed = false;

function readPwaInstallBannerDismissed(): boolean {
  if (sessionDismissed) {
    return true;
  }

  if (typeof window === 'undefined') {
    return false;
  }

  try {
    return isDismissedWithinWindow(window.localStorage.getItem(PWA_INSTALL_BANNER_DISMISSED_STORAGE_KEY));
  } catch {
    return sessionDismissed;
  }
}

function writePwaInstallBannerDismissed(): void {
  sessionDismissed = true;

  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(PWA_INSTALL_BANNER_DISMISSED_STORAGE_KEY, String(Date.now()));
  } catch {
    // Local storage can be unavailable in private or restricted browser contexts.
  }
}

export function PwaInstallBanner() {
  const [mode, setMode] = useState<PwaInstallBannerMode | null>(null);
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isPrompting, setIsPrompting] = useState(false);

  useEffect(() => {
    if (readPwaInstallBannerDismissed()) {
      return undefined;
    }

    const installEnvironment = detectPwaInstallEnvironment(window, navigator);
    if (installEnvironment === 'installed') {
      return undefined;
    }

    if (installEnvironment === 'ios-safari') {
      setMode('ios');
      return undefined;
    }

    function handleBeforeInstallPrompt(event: Event) {
      if (
        readPwaInstallBannerDismissed()
        || isStandaloneDisplayMode(window, navigator)
      ) {
        return;
      }

      event.preventDefault();
      setDeferredPrompt(event as BeforeInstallPromptEvent);
      setMode('install');
    }

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    return () => window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
  }, []);

  function handleDismiss() {
    writePwaInstallBannerDismissed();
    setDeferredPrompt(null);
    setMode(null);
  }

  async function handleInstall() {
    if (!deferredPrompt || isPrompting) {
      return;
    }

    setIsPrompting(true);

    try {
      await deferredPrompt.prompt();
      await deferredPrompt.userChoice.catch(() => null);
    } finally {
      writePwaInstallBannerDismissed();
      setDeferredPrompt(null);
      setMode(null);
      setIsPrompting(false);
    }
  }

  if (mode === null) {
    return null;
  }

  return (
    <div
      data-testid="pwa-install-banner"
      className="rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 shadow-[0_10px_24px_rgba(0,0,0,0.22)]"
    >
      <div className="flex min-h-10 items-center gap-3">
        <div
          aria-hidden="true"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-emerald-400/25 bg-emerald-500/10 text-emerald-200"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3v12" />
            <path d="m7 10 5 5 5-5" />
            <path d="M5 21h14" />
          </svg>
        </div>
        <p className="min-w-0 flex-1 text-sm font-medium leading-5 text-zinc-100">
          {mode === 'ios'
            ? 'Install Evogent: tap the Share button, then Add to Home Screen.'
            : 'Install Evogent for faster access.'}
        </p>
        {mode === 'install' ? (
          <button
            type="button"
            onClick={handleInstall}
            disabled={isPrompting}
            data-testid="pwa-install-button"
            className="inline-flex min-h-9 shrink-0 items-center justify-center rounded-lg border border-emerald-400/40 bg-emerald-500/12 px-3 text-sm font-medium text-emerald-100 transition hover:border-emerald-300/60 hover:bg-emerald-500/20 disabled:cursor-wait disabled:opacity-70"
          >
            {isPrompting ? 'Opening...' : 'Install Evogent'}
          </button>
        ) : null}
        <button
          type="button"
          onClick={handleDismiss}
          aria-label="Dismiss install banner"
          data-testid="pwa-install-dismiss"
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-zinc-800 text-xl leading-none text-zinc-400 transition hover:border-zinc-600 hover:bg-zinc-900 hover:text-zinc-100"
        >
          <span aria-hidden="true">&times;</span>
        </button>
      </div>
    </div>
  );
}
