'use client';

import { readString, type A2UIPrimitiveComponentProps } from '../shared';

export function KeyValue({ props, children }: A2UIPrimitiveComponentProps) {
  const label = readString(props.label) ?? 'Metric';
  const value = readString(props.value) ?? (typeof props.value === 'number' ? String(props.value) : '');

  return (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-zinc-200/70 py-2 last:border-b-0 dark:border-zinc-800/70">
      <span className="min-w-0 text-[13px] font-medium text-zinc-500 dark:text-zinc-400">{label}</span>
      <span className="flex min-w-0 items-center gap-2 text-right text-[14px] font-semibold text-zinc-900 dark:text-zinc-100">
        <span className="break-words">{value}</span>
        {children ? <span className="shrink-0">{children}</span> : null}
      </span>
    </div>
  );
}
