import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

import {
  PhoneNotificationCurationPanel,
  nativeNotificationCapabilitiesEqual,
  readNativeNotificationCapability,
  type NativeNotificationCapability,
} from './phone-notification-curation-panel';

type TestGlobal = typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

(globalThis as TestGlobal).IS_REACT_ACT_ENVIRONMENT = true;

const originalGlobals = {
  document: globalThis.document,
  fetch: globalThis.fetch,
  HTMLElement: globalThis.HTMLElement,
  MouseEvent: globalThis.MouseEvent,
  navigator: globalThis.navigator,
  window: globalThis.window,
};

afterEach(() => {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: originalGlobals.document,
  });
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: originalGlobals.fetch,
  });
  Object.defineProperty(globalThis, 'HTMLElement', {
    configurable: true,
    value: originalGlobals.HTMLElement,
  });
  Object.defineProperty(globalThis, 'MouseEvent', {
    configurable: true,
    value: originalGlobals.MouseEvent,
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: originalGlobals.navigator,
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: originalGlobals.window,
  });
});

function installDom(): JSDOM {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'https://127.0.0.1:3443/',
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: dom.window,
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: dom.window.document,
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: dom.window.navigator,
  });
  Object.defineProperty(globalThis, 'HTMLElement', {
    configurable: true,
    value: dom.window.HTMLElement,
  });
  Object.defineProperty(globalThis, 'MouseEvent', {
    configurable: true,
    value: dom.window.MouseEvent,
  });
  return dom;
}

const curatedSettings = {
  config: {
    schemaVersion: 1,
    mode: 'curated',
    lockScreenPreview: 'private',
    replacementScope: 'all_eligible',
    preservedPackages: [],
    replacementPackages: [],
  },
  state: 'loaded',
  observedApps: [],
  safeguards: {
    originalsAlwaysPreservedFor: ['Calls and alarms'],
    observeIsDefault: true,
    originalsPreservedByDefault: true,
    replacementScopeIsExplicit: true,
    preservedPackagesOverrideScope: true,
    keyOnlyCancellationIsBestEffort: true,
    exactReceiptRequired: true,
    digestProofRequired: true,
  },
};

describe('PhoneNotificationCurationPanel native capability recovery', () => {
  test('recognizes unchanged native capability snapshots', () => {
    const capability: NativeNotificationCapability = {
      schemaVersion: 1,
      digestSupported: true,
      listenerAccessGranted: true,
      postingPermissionGranted: true,
      appNotificationsEnabled: true,
      digestChannelEnabled: true,
      canPostDigest: true,
    };
    assert.equal(nativeNotificationCapabilitiesEqual(capability, { ...capability }), true);
    assert.equal(
      nativeNotificationCapabilitiesEqual(capability, {
        ...capability,
        listenerAccessGranted: false,
      }),
      false,
    );
    assert.equal(nativeNotificationCapabilitiesEqual(null, null), true);
    assert.equal(nativeNotificationCapabilitiesEqual(capability, null), false);
  });

  test('rejects malformed or incomplete native capability responses', () => {
    const dom = installDom();
    try {
      Object.defineProperty(dom.window, 'EvogentShell', {
        configurable: true,
        value: {
          getNotificationCapability: () => JSON.stringify({
            schemaVersion: 1,
            canPostDigest: false,
          }),
        },
      });
      assert.equal(readNativeNotificationCapability(), null);

      Object.defineProperty(dom.window, 'EvogentShell', {
        configurable: true,
        value: {
          getNotificationCapability: () => '{not-json',
        },
      });
      assert.equal(readNativeNotificationCapability(), null);
    } finally {
      dom.window.close();
    }
  });

  test('explains that Private keeps native Android content generic', async () => {
    const dom = installDom();
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: async () => ({
        ok: true,
        json: async () => curatedSettings,
      }),
    });
    const container = dom.window.document.getElementById('root');
    assert.ok(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(PhoneNotificationCurationPanel));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      assert.match(
        container.textContent ?? '',
        /Keep Android’s native digest generic; ranked details stay inside Evogent\./,
      );
      assert.match(
        container.textContent ?? '',
        /Show the ranked eligible-app summary in Android, including while the phone is locked\./,
      );
    } finally {
      await act(async () => {
        root.unmount();
      });
      dom.window.close();
    }
  });

  test('refreshes when the authenticated fallback shell becomes ready after mount', async () => {
    const dom = installDom();
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: async () => ({
        ok: true,
        json: async () => curatedSettings,
      }),
    });
    const container = dom.window.document.getElementById('root');
    assert.ok(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(PhoneNotificationCurationPanel));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      assert.equal(
        container.querySelector('[data-testid="notification-capability-alert"]'),
        null,
      );

      Object.defineProperty(dom.window, 'EvogentShell', {
        configurable: true,
        value: {
          getNotificationCapability: () => JSON.stringify({
            schemaVersion: 1,
            digestSupported: true,
            listenerAccessGranted: true,
            postingPermissionGranted: false,
            appNotificationsEnabled: false,
            digestChannelEnabled: true,
            canPostDigest: false,
          } satisfies NativeNotificationCapability),
          openNotificationSettings: () => 'opened',
        },
      });
      await act(async () => {
        dom.window.dispatchEvent(new dom.window.Event('evogent:native-bridge-ready'));
        await new Promise((resolve) => setTimeout(resolve, 80));
      });

      assert.ok(
        container.querySelector('[data-testid="notification-capability-alert"]'),
      );
    } finally {
      await act(async () => {
        root.unmount();
      });
      dom.window.close();
    }
  });

  test('recovers disabled listener access and coalesces a native return-event burst', async () => {
    const dom = installDom();
    let capabilityReadCount = 0;
    let openListenerSettingsCount = 0;
    let capability: NativeNotificationCapability = {
      schemaVersion: 1,
      digestSupported: true,
      listenerAccessGranted: false,
      postingPermissionGranted: true,
      appNotificationsEnabled: true,
      digestChannelEnabled: true,
      canPostDigest: false,
    };
    Object.defineProperty(dom.window, 'EvogentShell', {
      configurable: true,
      value: {
        getNotificationCapability: () => {
          capabilityReadCount += 1;
          return JSON.stringify(capability);
        },
        openNotificationListenerSettings: () => {
          openListenerSettingsCount += 1;
          return 'opened';
        },
        openNotificationSettings: () => 'opened',
      },
    });
    Object.defineProperty(dom.window.document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: async () => ({
        ok: true,
        json: async () => ({
          ...curatedSettings,
          config: {
            ...curatedSettings.config,
            mode: 'observe',
          },
        }),
      }),
    });

    const container = dom.window.document.getElementById('root');
    assert.ok(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(PhoneNotificationCurationPanel));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      assert.equal(capabilityReadCount, 1);

      const listenerSettingsButton = container.querySelector<HTMLButtonElement>(
        '[data-testid="open-android-notification-listener-settings"]',
      );
      assert.ok(listenerSettingsButton);
      assert.match(
        container.querySelector('[data-testid="notification-capability-alert"]')?.textContent ?? '',
        /cannot currently observe Android notifications/i,
      );
      assert.equal(
        container.querySelector('[data-testid="open-android-notification-settings"]'),
        null,
      );
      await act(async () => {
        listenerSettingsButton.dispatchEvent(
          new dom.window.MouseEvent('click', { bubbles: true }),
        );
      });
      assert.equal(openListenerSettingsCount, 1);

      capability = {
        ...capability,
        listenerAccessGranted: true,
        canPostDigest: true,
      };
      await act(async () => {
        dom.window.dispatchEvent(new dom.window.Event('focus'));
        dom.window.dispatchEvent(new dom.window.Event('pageshow'));
        dom.window.dispatchEvent(new dom.window.Event('evogent:native-bridge-ready'));
        dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
        await new Promise((resolve) => setTimeout(resolve, 80));
      });

      assert.equal(capabilityReadCount, 2);
      assert.equal(
        container.querySelector('[data-testid="notification-capability-alert"]'),
        null,
      );
    } finally {
      await act(async () => {
        root.unmount();
      });
      dom.window.close();
    }
  });

  test('shows an accessible denied-permission recovery and refreshes after Android settings returns', async () => {
    const dom = installDom();
    let openSettingsCount = 0;
    let capability: NativeNotificationCapability = {
      schemaVersion: 1,
      digestSupported: true,
      listenerAccessGranted: true,
      postingPermissionGranted: false,
      appNotificationsEnabled: false,
      digestChannelEnabled: true,
      canPostDigest: false,
    };
    Object.defineProperty(dom.window, 'EvogentShell', {
      configurable: true,
      value: {
        getNotificationCapability: () => JSON.stringify(capability),
        openNotificationSettings: () => {
          openSettingsCount += 1;
          return 'opened';
        },
      },
    });
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: async () => ({
        ok: true,
        json: async () => curatedSettings,
      }),
    });

    const container = dom.window.document.getElementById('root');
    assert.ok(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(PhoneNotificationCurationPanel));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const alert = container.querySelector<HTMLElement>(
        '[data-testid="notification-capability-alert"]',
      );
      const settingsButton = container.querySelector<HTMLButtonElement>(
        '[data-testid="open-android-notification-settings"]',
      );
      assert.ok(alert);
      assert.equal(alert.getAttribute('role'), 'alert');
      assert.match(alert.textContent ?? '', /Every Android original will stay visible/);
      assert.match(alert.textContent ?? '', /has not allowed Evogent to post/i);
      assert.ok(settingsButton);

      await act(async () => {
        settingsButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      });
      assert.equal(openSettingsCount, 1);

      capability = {
        ...capability,
        postingPermissionGranted: true,
        appNotificationsEnabled: true,
        canPostDigest: true,
      };
      await act(async () => {
        dom.window.dispatchEvent(new dom.window.Event('focus'));
        await new Promise((resolve) => setTimeout(resolve, 80));
      });

      assert.equal(
        container.querySelector('[data-testid="notification-capability-alert"]'),
        null,
      );
    } finally {
      await act(async () => {
        root.unmount();
      });
      dom.window.close();
    }
  });

  test('floors an active Detailed digest before and after saving Private', async () => {
    const dom = installDom();
    const order: string[] = [];
    const detailedSettings = {
      ...curatedSettings,
      config: { ...curatedSettings.config, lockScreenPreview: 'detailed' },
    };
    Object.defineProperty(dom.window, 'EvogentShell', {
      configurable: true,
      value: {
        synchronizeNotificationDigestPrivate: () => {
          order.push('private');
          return 'private';
        },
      },
    });
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: async (_input: unknown, init?: RequestInit) => {
        if (init?.method === 'PATCH') {
          order.push('patch-private');
          return { ok: true, json: async () => curatedSettings };
        }
        return { ok: true, json: async () => detailedSettings };
      },
    });
    const container = dom.window.document.getElementById('root');
    assert.ok(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(PhoneNotificationCurationPanel));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      const privateButton = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
        .find((button) => button.textContent?.includes('Private (recommended)'));
      assert.ok(privateButton);
      await act(async () => {
        privateButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      assert.deepEqual(order, ['private', 'patch-private', 'private']);
      assert.match(container.textContent ?? '', /Saved on this phone\./);
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
    }
  });

  test('keeps the current digest Private until Detailed is armed after its PATCH', async () => {
    const dom = installDom();
    const order: string[] = [];
    const savedDetailed = {
      ...curatedSettings,
      config: { ...curatedSettings.config, lockScreenPreview: 'detailed' },
    };
    Object.defineProperty(dom.window, 'EvogentShell', {
      configurable: true,
      value: {
        synchronizeNotificationDigestPrivate: () => {
          order.push('private');
          return 'private';
        },
        armNotificationDigestDetailed: () => {
          order.push('detailed-arm');
          return 'detailed-armed';
        },
      },
    });
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: async (_input: unknown, init?: RequestInit) => {
        if (init?.method === 'PATCH') {
          order.push('patch-detailed');
          return { ok: true, json: async () => savedDetailed };
        }
        return { ok: true, json: async () => curatedSettings };
      },
    });
    const container = dom.window.document.getElementById('root');
    assert.ok(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(PhoneNotificationCurationPanel));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      const detailedButton = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
        .find((button) => button.textContent?.startsWith('Detailed'));
      assert.ok(detailedButton);
      await act(async () => {
        detailedButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      assert.deepEqual(order, ['private', 'patch-detailed', 'detailed-arm']);
      assert.match(container.textContent ?? '', /Saved on this phone\./);
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
    }
  });

  test('does not PATCH preview settings without the native Private floor', async () => {
    const dom = installDom();
    let patchCount = 0;
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: async (_input: unknown, init?: RequestInit) => {
        if (init?.method === 'PATCH') patchCount += 1;
        return { ok: true, json: async () => curatedSettings };
      },
    });
    const container = dom.window.document.getElementById('root');
    assert.ok(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(PhoneNotificationCurationPanel));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      const detailedButton = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
        .find((button) => button.textContent?.startsWith('Detailed'));
      assert.ok(detailedButton);
      await act(async () => {
        detailedButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      assert.equal(patchCount, 0);
      assert.match(
        container.textContent ?? '',
        /Could not secure the Android digest before saving\./,
      );
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
    }
  });
});
