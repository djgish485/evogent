'use client';

import { useEffect, useRef } from 'react';
import { useOverlayDismiss } from '@/lib/overlay-dismiss';

interface NewSessionModalProps {
  claudeReasoningEffort: string;
  claudeReasoningOptions: Array<{
    value: string;
    label: string;
  }>;
  codexReasoningEffort: string;
  codexReasoningOptions: Array<{
    value: string;
    label: string;
  }>;
  codexFastMode: boolean;
  colorOptions: Array<{
    value: string;
    swatch: string;
  }>;
  error: string | null;
  isOpen: boolean;
  isProviderLoading: boolean;
  isSubmitting: boolean;
  provider: string;
  providerError: string | null;
  providerOptions: Array<{
    value: string;
    label: string;
  }>;
  selectedColor: string | null;
  sessionType: 'curator' | 'normal';
  title: string;
  workingDirectory: string;
  onClose: () => void;
  onAskAgent: () => void;
  onSubmit: () => void;
  onClaudeReasoningEffortChange: (value: string) => void;
  onCodexReasoningEffortChange: (value: string) => void;
  onCodexFastModeChange: (value: boolean) => void;
  onColorChange: (value: string | null) => void;
  onProviderChange: (value: string) => void;
  onSessionTypeChange: (value: 'curator' | 'normal') => void;
  onTitleChange: (value: string) => void;
  onWorkingDirectoryChange: (value: string) => void;
}

export function lockDocumentScrollForModal() {
  const scrollY = window.scrollY;
  const { body, documentElement } = document;
  const previousDocumentOverflow = documentElement.style.overflow;
  const previousBodyOverflow = body.style.overflow;
  const previousBodyOverscrollBehavior = body.style.overscrollBehavior;
  const previousBodyPosition = body.style.position;
  const previousBodyTop = body.style.top;
  const previousBodyWidth = body.style.width;

  documentElement.style.overflow = 'hidden';
  body.style.overflow = 'hidden';
  body.style.overscrollBehavior = 'contain';
  body.style.position = 'fixed';
  body.style.top = `-${scrollY}px`;
  body.style.width = '100%';

  return () => {
    documentElement.style.overflow = previousDocumentOverflow;
    body.style.overflow = previousBodyOverflow;
    body.style.overscrollBehavior = previousBodyOverscrollBehavior;
    body.style.position = previousBodyPosition;
    body.style.top = previousBodyTop;
    body.style.width = previousBodyWidth;
    window.scrollTo(0, scrollY);
  };
}

export function NewSessionModal({
  claudeReasoningEffort,
  claudeReasoningOptions,
  codexReasoningEffort,
  codexReasoningOptions,
  codexFastMode,
  colorOptions,
  error,
  isOpen,
  isProviderLoading,
  isSubmitting,
  provider,
  providerError,
  providerOptions,
  selectedColor,
  sessionType,
  title,
  workingDirectory,
  onClose,
  onAskAgent,
  onSubmit,
  onClaudeReasoningEffortChange,
  onCodexReasoningEffortChange,
  onCodexFastModeChange,
  onColorChange,
  onProviderChange,
  onSessionTypeChange,
  onTitleChange,
  onWorkingDirectoryChange,
}: NewSessionModalProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const { backdropProps } = useOverlayDismiss({
    enabled: isOpen,
    onClose,
    closeOnBackdropPress: !isSubmitting,
    closeOnEscape: !isSubmitting,
  });

  useEffect(() => {
    if (!isOpen) return;

    const focusTimer = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => {
      window.clearTimeout(focusTimer);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    return lockDocumentScrollForModal();
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div
      className="pointer-events-auto fixed inset-0 z-[90] flex h-dvh items-center justify-center overflow-hidden overscroll-contain p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-session-modal-title"
      style={{
        paddingTop: 'max(1rem, env(safe-area-inset-top))',
        paddingRight: 'max(1rem, env(safe-area-inset-right))',
        paddingBottom: 'max(1rem, env(safe-area-inset-bottom))',
        paddingLeft: 'max(1rem, env(safe-area-inset-left))',
      }}
    >
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-black/70"
        {...backdropProps}
      />
      <form
        data-testid="new-session-modal-dialog"
        className="relative z-[91] max-h-[calc(100vh-2rem)] w-full max-w-md overflow-y-auto overscroll-contain rounded-[1.75rem] border border-zinc-800 bg-zinc-950 p-5 shadow-2xl [scrollbar-gutter:stable]"
        style={{
          maxHeight: 'calc(100dvh - max(1rem, env(safe-area-inset-top)) - max(1rem, env(safe-area-inset-bottom)))',
        }}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div className="space-y-2">
          <h2 id="new-session-modal-title" className="text-xl font-semibold text-zinc-50">Start a chat session</h2>
        </div>
        <label className="mt-5 block">
          <span className="mb-2 block text-sm font-medium text-zinc-200">Provider</span>
          <select
            value={provider}
            onChange={(event) => onProviderChange(event.target.value)}
            disabled={isSubmitting || isProviderLoading || providerOptions.length === 0}
            className="w-full rounded-2xl border border-zinc-700 bg-zinc-900 px-4 py-3 text-sm text-zinc-100 outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-400/20 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isProviderLoading && providerOptions.length === 0 ? (
              <option value={provider}>Checking available providers...</option>
            ) : providerOptions.length === 0 ? (
              <option value={provider}>No available providers</option>
            ) : (
              providerOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))
            )}
          </select>
          {providerError && (
            <p className="mt-2 text-xs text-red-300">{providerError}</p>
          )}
        </label>
        {provider === 'claude' ? (
          <label className="mt-5 block">
            <span className="mb-2 block text-sm font-medium text-zinc-200">Reasoning level</span>
            <select
              value={claudeReasoningEffort}
              onChange={(event) => onClaudeReasoningEffortChange(event.target.value)}
              disabled={isSubmitting}
              className="w-full rounded-2xl border border-zinc-700 bg-zinc-900 px-4 py-3 text-sm text-zinc-100 outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-400/20 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {claudeReasoningOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {provider === 'codex' ? (
          <div className="mt-5">
            <span className="mb-2 block text-sm font-medium text-zinc-200">Codex reasoning</span>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {codexReasoningOptions.map((option) => {
                const isSelected = codexReasoningEffort === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => onCodexReasoningEffortChange(option.value)}
                    disabled={isSubmitting}
                    className={`rounded-xl border px-3 py-2 text-sm transition ${
                      isSelected
                        ? 'border-sky-400/70 bg-sky-500/10 text-sky-100'
                        : 'border-zinc-700 bg-zinc-950 text-zinc-300 hover:border-zinc-600'
                    } disabled:cursor-not-allowed disabled:opacity-60`}
                    data-testid={`new-session-codex-reasoning-option-${option.value}`}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
            <label className="mt-3 flex items-center justify-between gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/70 px-4 py-3">
              <span className="min-w-0">
                <span className="flex items-center gap-2 text-sm font-medium text-zinc-100">
                  Fast mode (gpt-5.5)
                  <span
                    className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-zinc-700 text-xs text-zinc-400"
                    title="Use OpenAI's fast service tier for this session. Faster responses; tradeoff vs. flex tier is not publicly documented."
                  >
                    ?
                  </span>
                </span>
              </span>
              <input
                type="checkbox"
                checked={codexFastMode}
                onChange={(event) => onCodexFastModeChange(event.target.checked)}
                disabled={isSubmitting}
                className="h-5 w-5 rounded border-zinc-700 bg-zinc-950 text-sky-400 focus:ring-sky-400/30 disabled:cursor-not-allowed disabled:opacity-60"
                data-testid="new-session-codex-fast-mode"
              />
            </label>
          </div>
        ) : null}
        <label className="mt-5 block">
          <span className="mb-2 block text-sm font-medium text-zinc-200">Session name</span>
          <input
            ref={inputRef}
            type="text"
            value={title}
            onChange={(event) => onTitleChange(event.target.value)}
            placeholder="Session title"
            disabled={isSubmitting}
            className="w-full rounded-2xl border border-zinc-700 bg-zinc-900 px-4 py-3 text-sm text-zinc-100 outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-400/20 disabled:cursor-not-allowed disabled:opacity-60"
          />
        </label>
        <label className="mt-5 block">
          <span className="mb-2 block text-sm font-medium text-zinc-200">Session type</span>
          <select
            value={sessionType}
            onChange={(event) => onSessionTypeChange(event.target.value === 'curator' ? 'curator' : 'normal')}
            disabled={isSubmitting}
            className="w-full rounded-2xl border border-zinc-700 bg-zinc-900 px-4 py-3 text-sm text-zinc-100 outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-400/20 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <option value="normal">Normal chat</option>
            <option value="curator">Curator session</option>
          </select>
          <p className="mt-2 text-xs text-zinc-500">Curator sessions can discuss feed policy and directly edit the curator config files.</p>
        </label>
        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="text-sm font-medium text-zinc-200">Session color</span>
            <button
              type="button"
              onClick={() => onColorChange(null)}
              disabled={isSubmitting || selectedColor === null}
              className="text-xs text-zinc-400 transition hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Use default
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {colorOptions.map((option) => {
              const isSelected = option.value === selectedColor;
              return (
                <button
                  key={option.value}
                  type="button"
                  aria-label={`Use ${option.value} session color`}
                  aria-pressed={isSelected}
                  onClick={() => onColorChange(option.value)}
                  disabled={isSubmitting}
                  className={`flex h-10 w-10 items-center justify-center rounded-full border transition ${
                    isSelected
                      ? 'border-white/70 bg-zinc-900'
                      : 'border-zinc-700 bg-zinc-950 hover:border-zinc-500'
                  } disabled:cursor-not-allowed disabled:opacity-60`}
                >
                  <span
                    className="h-5 w-5 rounded-full"
                    style={{ backgroundColor: option.swatch }}
                  />
                </button>
              );
            })}
          </div>
        </div>
        <label className="mt-4 block">
          <span className="mb-2 block text-sm font-medium text-zinc-200">Working directory</span>
          <input
            type="text"
            value={workingDirectory}
            onChange={(event) => onWorkingDirectoryChange(event.target.value)}
            placeholder="/root/my-project"
            disabled={isSubmitting}
            className="w-full rounded-2xl border border-zinc-700 bg-zinc-900 px-4 py-3 text-sm text-zinc-100 outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-400/20 disabled:cursor-not-allowed disabled:opacity-60"
          />
          <p className="mt-2 text-xs text-zinc-500">Optional. Leave blank to use the evogent working directory.</p>
        </label>
        {error && (
          <p className="mt-3 rounded-2xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
            {error}
          </p>
        )}
        <div className="mt-5 flex items-center justify-end gap-3" data-testid="new-session-modal-actions">
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="rounded-full border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onAskAgent}
            disabled={isSubmitting || isProviderLoading || providerOptions.length === 0}
            className="rounded-full border border-sky-500/40 bg-sky-500/10 px-4 py-2 text-sm font-medium text-sky-100 transition hover:border-sky-400/60 hover:bg-sky-500/15 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Ask Agent
          </button>
          <button
            type="submit"
            disabled={isSubmitting || isProviderLoading || providerOptions.length === 0}
            className="rounded-full bg-sky-400 px-4 py-2 text-sm font-semibold text-zinc-950 transition hover:bg-sky-300 disabled:cursor-not-allowed disabled:bg-sky-400/60"
          >
            {isSubmitting ? 'Creating...' : 'Create session'}
          </button>
        </div>
      </form>
    </div>
  );
}
