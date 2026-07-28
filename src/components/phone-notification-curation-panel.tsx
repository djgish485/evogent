'use client';

import { useCallback, useEffect, useState } from 'react';

type NotificationMode = 'observe' | 'curated' | 'paused';
type LockScreenPreview = 'private' | 'detailed';

interface ObservedApp {
  packageName: string;
  label: string;
  lastSeenAt: string;
  notificationCount: number;
  preserved: boolean;
  replacementAllowed: boolean;
}

interface SettingsView {
  config: {
    schemaVersion: 1;
    mode: NotificationMode;
    lockScreenPreview: LockScreenPreview;
    preservedPackages: string[];
    replacementPackages: string[];
  };
  state: 'default' | 'loaded' | 'invalid';
  observedApps: ObservedApp[];
  safeguards: {
    originalsAlwaysPreservedFor: string[];
    observeIsDefault: true;
    originalsPreservedByDefault: true;
    replacementIsPerPackage: true;
    keyOnlyCancellationIsBestEffort: true;
    exactReceiptRequired: true;
    digestProofRequired: true;
  };
}

const MODE_OPTIONS: Array<{
  value: NotificationMode;
  label: string;
  description: string;
}> = [
  {
    value: 'observe',
    label: 'Observe',
    description: 'Mirror and organize notifications in Evogent. Android remains unchanged.',
  },
  {
    value: 'curated',
    label: 'Curated shade',
    description: 'Organize notifications in Evogent. Android originals stay unless you separately allow best-effort replacement for an app.',
  },
  {
    value: 'paused',
    label: 'Paused',
    description: 'Stop adding new phone notifications to Evogent. Android remains unchanged.',
  },
];

function formatLastSeen(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function PhoneNotificationCurationPanel() {
  const [view, setView] = useState<SettingsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setStatus(null);
    try {
      const response = await fetch('/api/phone-notifications/settings', {
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`Error ${response.status}`);
      setView(await response.json() as SettingsView);
    } catch {
      setStatus('Could not load notification curation settings.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const update = useCallback(async (patch: Record<string, unknown>) => {
    setSaving(true);
    setStatus(null);
    try {
      const response = await fetch('/api/phone-notifications/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const payload = await response.json() as SettingsView & { error?: string };
      if (!response.ok) throw new Error(payload.error || `Error ${response.status}`);
      setView(payload);
      setStatus('Saved on this phone.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not save settings.');
    } finally {
      setSaving(false);
    }
  }, []);

  if (loading) {
    return (
      <div
        data-testid="phone-notification-curation-panel"
        className="min-h-72 flex-1 rounded-lg border border-zinc-800 bg-zinc-900 p-4 text-sm text-zinc-400"
      >
        Loading notification curation…
      </div>
    );
  }

  if (!view) {
    return (
      <div
        data-testid="phone-notification-curation-panel"
        className="min-h-72 flex-1 rounded-lg border border-red-900/70 bg-red-950/20 p-4 text-sm text-red-100"
      >
        <p>{status || 'Notification curation settings are unavailable.'}</p>
        <button
          type="button"
          onClick={() => void load()}
          className="mt-3 min-h-11 rounded-lg border border-red-800 px-3 py-2 text-sm hover:bg-red-950/60"
        >
          Retry
        </button>
      </div>
    );
  }

  const selectedMode = view.config.mode;
  const preserved = new Set(view.config.preservedPackages);
  const replacementAllowed = new Set(view.config.replacementPackages);

  return (
    <div
      data-testid="phone-notification-curation-panel"
      className="min-h-72 flex-1 space-y-5 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-900 p-4 text-sm text-zinc-100"
    >
      {view.state === 'invalid' ? (
        <div role="alert" className="rounded-lg border border-amber-800/70 bg-amber-950/30 p-3 text-amber-100">
          The local settings file was invalid, so Evogent fell back to Observe. Saving any choice
          below will replace it with a valid private settings file.
        </div>
      ) : null}

      <section aria-labelledby="notification-mode-heading">
        <h3 id="notification-mode-heading" className="font-semibold text-zinc-100">
          What Evogent does with new notifications
        </h3>
        <div className="mt-3 grid gap-2">
          {MODE_OPTIONS.map((option) => {
            const selected = selectedMode === option.value;
            return (
              <button
                key={option.value}
                type="button"
                disabled={saving}
                aria-pressed={selected}
                onClick={() => void update({
                  mode: option.value,
                  ...(option.value === 'curated' ? { confirmCurated: true } : {}),
                })}
                className={`min-h-16 rounded-xl border p-3 text-left transition-colors disabled:opacity-60 ${
                  selected
                    ? 'border-sky-600 bg-sky-950/40'
                    : 'border-zinc-700 bg-zinc-950/60 hover:border-zinc-600'
                }`}
              >
                <span className="block font-medium text-zinc-100">{option.label}</span>
                <span className="mt-1 block text-xs leading-5 text-zinc-400">{option.description}</span>
              </button>
            );
          })}
        </div>
        {selectedMode === 'curated' ? (
          <div className="mt-3 rounded-lg border border-sky-900/70 bg-sky-950/20 p-3 text-xs leading-5 text-sky-100">
            Curated shade is reversible: choose Observe at any time. It still preserves every
            Android original by default. Replacement is a separate per-app choice below.
          </div>
        ) : null}
      </section>

      <section aria-labelledby="lock-screen-preview-heading">
        <h3 id="lock-screen-preview-heading" className="font-semibold text-zinc-100">
          Lock-screen digest preview
        </h3>
        <p className="mt-1 text-xs leading-5 text-zinc-400">
          This affects Evogent’s own digest only. It does not replace Android’s lock screen,
          media controls, alarms, At a Glance, emergency surfaces, or system UI.
        </p>
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup" aria-labelledby="lock-screen-preview-heading">
          {([
            {
              value: 'private' as const,
              label: 'Private (recommended)',
              description: 'The locked screen says only that curated notifications are ready.',
            },
            {
              value: 'detailed' as const,
              label: 'Detailed',
              description: 'Show the newest eligible app summary while the phone is locked.',
            },
          ]).map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={view.config.lockScreenPreview === option.value}
              disabled={saving}
              onClick={() => void update({ lockScreenPreview: option.value })}
              className={`min-h-20 rounded-xl border p-3 text-left disabled:opacity-60 ${
                view.config.lockScreenPreview === option.value
                  ? 'border-sky-600 bg-sky-950/40'
                  : 'border-zinc-700 bg-zinc-950/60 hover:border-zinc-600'
              }`}
            >
              <span className="block font-medium">{option.label}</span>
              <span className="mt-1 block text-xs leading-5 text-zinc-400">{option.description}</span>
            </button>
          ))}
        </div>
      </section>

      <section aria-labelledby="notification-safeguards-heading">
        <h3 id="notification-safeguards-heading" className="font-semibold text-zinc-100">
          Originals Evogent always keeps
        </h3>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs leading-5 text-zinc-400">
          {view.safeguards.originalsAlwaysPreservedFor.map((label) => (
            <li key={label}>{label}</li>
          ))}
        </ul>
        <p className="mt-2 text-xs leading-5 text-zinc-500">
          Evogent never reads notification action payloads. Known one-time codes and secret
          notifications are stripped before local loopback transport and storage. Protected
          categories stay Android-owned even if an app is on the replacement list.
        </p>
      </section>

      <section aria-labelledby="replacement-apps-heading">
        <h3 id="replacement-apps-heading" className="font-semibold text-zinc-100">
          Allow best-effort replacement for these apps
        </h3>
        <p id="replacement-apps-explanation" className="mt-1 text-xs leading-5 text-zinc-400">
          Off by default. When enabled in Curated shade, Evogent may replace an eligible ordinary
          notification with its digest after receipt and active-state checks. Android only permits
          cancellation by notification key, not by an atomic version token, so a same-key update can
          still race the final check. Turn this off, choose Observe, or mark the app “always keep” to
          stop future replacement attempts.
        </p>
        {view.observedApps.length > 0 ? (
          <div className="mt-3 space-y-2">
            {view.observedApps.map((app) => {
              const checked = replacementAllowed.has(app.packageName);
              const blocked = preserved.has(app.packageName);
              const descriptionId = `replacement-${app.packageName.replace(/[^A-Za-z0-9_-]/g, '-')}`;
              return (
                <label
                  key={app.packageName}
                  className="flex min-h-16 cursor-pointer items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-950/50 px-3 py-2"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={saving || blocked}
                    aria-describedby={`replacement-apps-explanation ${descriptionId}`}
                    onChange={() => {
                      const next = new Set(replacementAllowed);
                      if (checked) next.delete(app.packageName);
                      else next.add(app.packageName);
                      void update({
                        replacementPackages: [...next],
                        ...(!checked ? { confirmBestEffortReplacement: true } : {}),
                      });
                    }}
                    className="h-5 w-5 accent-amber-500"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-zinc-100">{app.label}</span>
                    <span id={descriptionId} className="block text-[11px] leading-4 text-zinc-500">
                      {blocked
                        ? 'Blocked because this app is set to always keep originals.'
                        : checked
                          ? 'Best-effort replacement allowed; uncheck to revoke.'
                          : 'Android original preserved.'}
                    </span>
                  </span>
                  <span className="text-xs text-zinc-500">{app.notificationCount}</span>
                </label>
              );
            })}
          </div>
        ) : (
          <p className="mt-3 rounded-lg border border-dashed border-zinc-700 p-3 text-xs text-zinc-500">
            Apps appear here after Evogent observes a notification. Until then, every Android
            original is preserved.
          </p>
        )}
      </section>

      <section aria-labelledby="preserved-apps-heading">
        <h3 id="preserved-apps-heading" className="font-semibold text-zinc-100">
          Always keep originals from these apps
        </h3>
        <p className="mt-1 text-xs leading-5 text-zinc-400">
          This overrides the replacement list as an extra block. Android originals also remain
          unchanged while Observe or Paused is selected.
        </p>
        {view.observedApps.length > 0 ? (
          <div className="mt-3 space-y-2">
            {view.observedApps.map((app) => {
              const checked = preserved.has(app.packageName);
              return (
                <label
                  key={app.packageName}
                  className="flex min-h-14 cursor-pointer items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-950/50 px-3 py-2"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={saving}
                    onChange={() => {
                      const next = new Set(preserved);
                      if (checked) next.delete(app.packageName);
                      else next.add(app.packageName);
                      void update({ preservedPackages: [...next] });
                    }}
                    className="h-5 w-5 accent-sky-500"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-zinc-100">{app.label}</span>
                    <span className="block truncate text-[11px] text-zinc-500">
                      Last seen {formatLastSeen(app.lastSeenAt)}
                    </span>
                  </span>
                  <span className="text-xs text-zinc-500">{app.notificationCount}</span>
                </label>
              );
            })}
          </div>
        ) : (
          <p className="mt-3 rounded-lg border border-dashed border-zinc-700 p-3 text-xs text-zinc-500">
            No app notifications have been observed yet.
          </p>
        )}
      </section>

      <div className="border-t border-zinc-800 pt-3">
        <p aria-live="polite" className="text-xs text-zinc-400">
          {saving ? 'Saving…' : status || 'Settings and notification content stay on this phone.'}
        </p>
      </div>
    </div>
  );
}
