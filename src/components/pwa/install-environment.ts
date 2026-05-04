export const PWA_INSTALL_BANNER_DISMISSED_STORAGE_KEY = 'evogent.pwa-install-banner.dismissed-at';
export const PWA_INSTALL_BANNER_DISMISS_MS = 30 * 24 * 60 * 60 * 1000;

interface DisplayModeWindow {
  matchMedia?: (query: string) => { matches: boolean };
}

interface InstallNavigator {
  userAgent?: string;
  platform?: string;
  maxTouchPoints?: number;
  standalone?: boolean;
}

export type PwaInstallEnvironment = 'installed' | 'ios-safari' | 'unsupported';

export function isStandaloneDisplayMode(
  windowLike?: DisplayModeWindow | null,
  navigatorLike?: InstallNavigator | null,
): boolean {
  if (navigatorLike?.standalone === true) {
    return true;
  }

  if (typeof windowLike?.matchMedia !== 'function') {
    return false;
  }

  try {
    return windowLike.matchMedia('(display-mode: standalone)').matches;
  } catch {
    return false;
  }
}

export function isIosSafari(navigatorLike: InstallNavigator): boolean {
  const userAgent = navigatorLike.userAgent ?? '';
  const platform = navigatorLike.platform ?? '';
  const maxTouchPoints = navigatorLike.maxTouchPoints ?? 0;
  const isiPhoneOrIpad = /iPhone|iPad|iPod/i.test(userAgent);
  const isModernIpad = /Macintosh/i.test(userAgent) && platform === 'MacIntel' && maxTouchPoints > 1;
  const isSafari = /Safari/i.test(userAgent)
    && !/(CriOS|FxiOS|EdgiOS|OPiOS|Chrome|Chromium|Android)/i.test(userAgent);

  return (isiPhoneOrIpad || isModernIpad) && isSafari;
}

export function detectPwaInstallEnvironment(
  windowLike?: DisplayModeWindow | null,
  navigatorLike?: InstallNavigator | null,
): PwaInstallEnvironment {
  if (isStandaloneDisplayMode(windowLike, navigatorLike)) {
    return 'installed';
  }

  if (navigatorLike && isIosSafari(navigatorLike)) {
    return 'ios-safari';
  }

  return 'unsupported';
}

export function isDismissedWithinWindow(
  dismissedAtValue: string | null,
  nowMs: number = Date.now(),
  dismissWindowMs: number = PWA_INSTALL_BANNER_DISMISS_MS,
): boolean {
  if (!dismissedAtValue) {
    return false;
  }

  const dismissedAtMs = Number(dismissedAtValue);
  if (!Number.isFinite(dismissedAtMs)) {
    return false;
  }

  return nowMs - dismissedAtMs < dismissWindowMs;
}
