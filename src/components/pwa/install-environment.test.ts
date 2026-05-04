import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  detectPwaInstallEnvironment,
  isDismissedWithinWindow,
  isIosSafari,
  isStandaloneDisplayMode,
  PWA_INSTALL_BANNER_DISMISS_MS,
} from './install-environment';

const iphoneSafari = {
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  platform: 'iPhone',
  maxTouchPoints: 5,
};

test('detects standalone PWA display mode', () => {
  assert.equal(
    isStandaloneDisplayMode({ matchMedia: (query) => ({ matches: query === '(display-mode: standalone)' }) }),
    true,
  );
  assert.equal(isStandaloneDisplayMode(null, { standalone: true }), true);
});

describe('PWA install environment detection', () => {
  test('detects iPhone Safari for the Add to Home Screen hint', () => {
    assert.equal(isIosSafari(iphoneSafari), true);
    assert.equal(detectPwaInstallEnvironment(null, iphoneSafari), 'ios-safari');
  });

  test('does not show the iOS hint in Chrome on iOS', () => {
    const chromeIos = {
      ...iphoneSafari,
      userAgent: iphoneSafari.userAgent.replace('Version/17.4 Mobile/15E148 Safari/604.1', 'CriOS/124.0.6367.111 Mobile/15E148 Safari/604.1'),
    };

    assert.equal(isIosSafari(chromeIos), false);
    assert.equal(detectPwaInstallEnvironment(null, chromeIos), 'unsupported');
  });

  test('installed apps suppress the install banner', () => {
    assert.equal(detectPwaInstallEnvironment(null, { ...iphoneSafari, standalone: true }), 'installed');
  });
});

describe('PWA install banner dismissal', () => {
  test('stays dismissed inside the 30 day window', () => {
    const now = 1_000_000;
    assert.equal(isDismissedWithinWindow(String(now - 1_000), now), true);
  });

  test('expires after the 30 day window', () => {
    const now = 1_000_000 + PWA_INSTALL_BANNER_DISMISS_MS;
    assert.equal(isDismissedWithinWindow('1000000', now), false);
  });
});
