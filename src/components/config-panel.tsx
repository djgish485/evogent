'use client';

import { useEffect, useState } from 'react';

interface ConfigPanelProps {
  open: boolean;
  onClose: () => void;
}

type ConfigTabKey =
  | 'config'
  | 'curation-prompt'
  | 'curate-command'
  | 'reflect-command'
  | 'enrichment-instructions'
  | 'chat-instructions'
  | 'runtime-instructions'
  | 'preference-insights'
  | 'preferences'
  | 'cache-hints'
  | 'skills';

interface CacheHintAccountView {
  handle: string;
  includeReplies: boolean;
}

interface CacheHintsView {
  state: 'available' | 'missing' | 'invalid';
  updatedAt: string | null;
  updatedBy: string | null;
  accounts: CacheHintAccountView[];
  searches: string[];
}

interface ConfigTabDefinition {
  key: ConfigTabKey;
  label: string;
  heading: string;
  placeholder: string;
  endpoint: string;
  readOnly?: boolean;
  view?: 'text' | 'cache-hints';
}

const TABS: ConfigTabDefinition[] = [
  {
    key: 'config',
    label: 'App Config',
    heading: 'Edit App Config',
    placeholder: 'Set brain provider, usage level, schedule, and app-level settings...',
    endpoint: '/api/config',
  },
  {
    key: 'curation-prompt',
    label: 'Curation Prompt',
    heading: 'Edit Curation Prompt',
    placeholder: 'Describe curation priorities, topics, and sources to prefer...',
    endpoint: '/api/config?target=curation-prompt',
  },
  {
    key: 'curate-command',
    label: 'Curate',
    heading: 'Curate Command',
    placeholder: '',
    endpoint: '/api/config?target=curate-command',
    readOnly: true,
  },
  {
    key: 'reflect-command',
    label: 'Reflect',
    heading: 'Reflect Command',
    placeholder: '',
    endpoint: '/api/config?target=reflect-command',
    readOnly: true,
  },
  {
    key: 'enrichment-instructions',
    label: 'Enrichment',
    heading: 'Enrichment Instructions',
    placeholder: '',
    endpoint: '/api/config?target=enrichment-instructions',
    readOnly: true,
  },
  {
    key: 'chat-instructions',
    label: 'Chat',
    heading: 'Chat Agent Instructions',
    placeholder: '',
    endpoint: '/api/config?target=chat-instructions',
    readOnly: true,
  },
  {
    key: 'runtime-instructions',
    label: 'Brain Instructions',
    heading: 'Brain Runtime Instructions',
    placeholder: '',
    endpoint: '/api/config?target=runtime-instructions',
    readOnly: true,
  },
  {
    key: 'preference-insights',
    label: 'Insights',
    heading: 'Preference Insights',
    placeholder: '',
    endpoint: '/api/config?target=preference-insights',
    readOnly: true,
  },
  {
    key: 'preferences',
    label: 'Preferences',
    heading: 'Learned Preferences',
    placeholder: '',
    endpoint: '/api/config?target=preferences',
    readOnly: true,
  },
  {
    key: 'cache-hints',
    label: 'Cache Hints',
    heading: 'Cache Hints',
    placeholder: '',
    endpoint: '/api/config?target=cache-hints',
    readOnly: true,
    view: 'cache-hints',
  },
  {
    key: 'skills',
    label: 'Skills',
    heading: 'Installed Skills',
    placeholder: '',
    endpoint: '/api/config?target=skills',
    readOnly: true,
  },
];

function tabForKey(key: ConfigTabKey): ConfigTabDefinition {
  return TABS.find((tab) => tab.key === key) ?? TABS[0];
}

function formatCacheHintsTimestamp(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function CacheHintsPanel({
  data,
  isLoading,
}: {
  data: CacheHintsView | null;
  isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <div
        data-testid="config-cache-hints-view"
        className="h-full min-h-72 w-full flex-1 rounded-lg border border-zinc-800 bg-zinc-900 p-3 text-sm text-zinc-400"
      >
        Loading cache hints...
      </div>
    );
  }

  if (!data || data.state === 'missing') {
    return (
      <div
        data-testid="config-cache-hints-view"
        className="h-full min-h-72 w-full flex-1 rounded-lg border border-zinc-800 bg-zinc-900 p-3 text-sm text-zinc-300"
      >
        <p className="font-medium text-zinc-100">No cache hints written yet.</p>
        <p className="mt-2 text-zinc-400">The next curation cycle will write `data/cache-hints.json` when it has hints to carry forward.</p>
      </div>
    );
  }

  if (data.state === 'invalid') {
    return (
      <div
        data-testid="config-cache-hints-view"
        className="h-full min-h-72 w-full flex-1 rounded-lg border border-zinc-800 bg-zinc-900 p-3 text-sm text-zinc-300"
      >
        <p className="font-medium text-zinc-100">Cache hints file is not valid JSON.</p>
        <p className="mt-2 text-zinc-400">Fix `data/cache-hints.json` to restore the formatted view.</p>
      </div>
    );
  }

  const formattedUpdatedAt = formatCacheHintsTimestamp(data.updatedAt);

  return (
    <div
      data-testid="config-cache-hints-view"
      className="h-full min-h-72 w-full flex-1 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-900 p-3 text-sm text-zinc-100"
    >
      <div className="mb-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-400">
        <span>{formattedUpdatedAt ? `Updated ${formattedUpdatedAt}` : 'Updated time unavailable'}</span>
        <span>{data.updatedBy ? `By ${data.updatedBy}` : 'Updated by unavailable'}</span>
      </div>

      <div className="space-y-4">
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-400">Accounts</h3>
            <span className="text-xs text-zinc-500">{data.accounts.length}</span>
          </div>
          {data.accounts.length > 0 ? (
            <div className="space-y-2" data-testid="config-cache-hints-accounts">
              {data.accounts.map((account) => (
                <div
                  key={`${account.handle}-${account.includeReplies ? 'replies' : 'posts'}`}
                  className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950/70 px-3 py-2"
                >
                  <span className="font-medium text-zinc-100">@{account.handle}</span>
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[11px] ${
                      account.includeReplies
                        ? 'border-emerald-700/60 bg-emerald-950/60 text-emerald-200'
                        : 'border-zinc-700 bg-zinc-900 text-zinc-300'
                    }`}
                  >
                    {account.includeReplies ? 'Replies included' : 'Posts only'}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="rounded-lg border border-dashed border-zinc-800 px-3 py-4 text-zinc-400">No account hints.</p>
          )}
        </section>

        <section>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-400">Search Queries</h3>
            <span className="text-xs text-zinc-500">{data.searches.length}</span>
          </div>
          {data.searches.length > 0 ? (
            <div className="flex flex-wrap gap-2" data-testid="config-cache-hints-searches">
              {data.searches.map((search) => (
                <span
                  key={search}
                  className="rounded-full border border-sky-800/70 bg-sky-950/40 px-3 py-1 text-xs text-sky-100"
                >
                  {search}
                </span>
              ))}
            </div>
          ) : (
            <p className="rounded-lg border border-dashed border-zinc-800 px-3 py-4 text-zinc-400">No search query hints.</p>
          )}
        </section>
      </div>
    </div>
  );
}

export function ConfigPanel({ open, onClose }: ConfigPanelProps) {
  const [activeTab, setActiveTab] = useState<ConfigTabKey>('config');
  const [content, setContent] = useState('');
  const [cacheHints, setCacheHints] = useState<CacheHintsView | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const activeTabDefinition = tabForKey(activeTab);
  const isReadOnly = Boolean(activeTabDefinition.readOnly);
  const usesCacheHintsView = activeTabDefinition.view === 'cache-hints';

  useEffect(() => {
    if (!open) return;
    setActiveTab('config');
  }, [open]);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;

    async function loadConfig() {
      setIsLoading(true);
      setStatus(null);
      setContent('');
      setCacheHints(null);

      try {
        const response = await fetch(activeTabDefinition.endpoint, { cache: 'no-store' });
        if (!response.ok) throw new Error(`Error ${response.status}`);
        const data = (await response.json()) as { content: string; cacheHints?: CacheHintsView };
        if (!cancelled) {
          setContent(data.content);
          setCacheHints(data.cacheHints ?? null);
        }
      } catch {
        if (!cancelled) {
          setStatus('Failed to load config');
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    loadConfig();

    return () => {
      cancelled = true;
    };
  }, [activeTabDefinition.endpoint, open]);

  if (!open) return null;

  return (
    <div data-testid="config-panel-overlay" className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-3">
      <div data-testid="config-panel-shell" className="flex h-[100dvh] w-full flex-col border border-zinc-800 bg-zinc-950 p-4 shadow-2xl max-sm:rounded-none max-sm:pt-[calc(env(safe-area-inset-top)+1rem)] max-sm:pb-[calc(env(safe-area-inset-bottom)+1rem)] sm:h-auto sm:max-w-2xl sm:rounded-xl">
        <div className="mb-3 flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-zinc-100">{activeTabDefinition.heading}</h2>
            <button
              type="button"
              onClick={onClose}
              className="shrink-0 min-h-11 rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
            >
              Close
            </button>
          </div>
          <div role="tablist" aria-label="Config editor tabs" className="-mx-4 flex items-center gap-4 overflow-x-auto border-b border-zinc-800 px-4 scrollbar-none">
            {TABS.map((tab) => {
              const isActive = activeTab === tab.key;
              return (
                <button
                  key={tab.key}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => setActiveTab(tab.key)}
                  className={`-mb-px shrink-0 whitespace-nowrap border-b px-0 pb-2 text-xs transition-colors ${
                    isActive
                      ? 'border-zinc-100 text-zinc-100'
                      : 'border-transparent text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>
        {usesCacheHintsView ? (
          <CacheHintsPanel data={cacheHints} isLoading={isLoading} />
        ) : (
          <textarea
            value={content}
            disabled={isLoading || isSaving}
            readOnly={isReadOnly}
            onChange={(event) => {
              if (!isReadOnly) {
                setContent(event.target.value);
              }
            }}
            data-testid="config-panel-textarea"
            className={`h-full min-h-72 w-full flex-1 rounded-lg border border-zinc-800 bg-zinc-900 p-3 text-sm text-zinc-100 outline-none ring-0 placeholder:text-zinc-500 ${
              isReadOnly
                ? 'cursor-default opacity-80'
                : 'focus:border-zinc-700'
            }`}
            placeholder={activeTabDefinition.placeholder}
          />
        )}
        <div className="mt-3 flex items-center justify-between gap-3">
          <p className="text-xs text-zinc-500">{status || ''}</p>
          {isReadOnly ? (
            <p className="text-xs text-zinc-500">Read only</p>
          ) : (
            <button
              type="button"
              disabled={isLoading || isSaving}
              onClick={async () => {
                setIsSaving(true);
                setStatus(null);
                try {
                  const response = await fetch(activeTabDefinition.endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content }),
                  });
                  if (!response.ok) throw new Error(`Error ${response.status}`);
                  setStatus('Saved');
                } catch {
                  setStatus('Failed to save');
                } finally {
                  setIsSaving(false);
                }
              }}
              className="min-h-11 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100 hover:bg-zinc-700 disabled:opacity-60"
              data-testid="config-save-button"
            >
              {isSaving ? 'Saving...' : 'Save'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
