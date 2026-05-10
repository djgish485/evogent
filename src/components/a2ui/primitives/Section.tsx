'use client';

import { useState } from 'react';
import { cn, readBoolean, readString, type A2UIPrimitiveComponentProps } from '../shared';

export function Section({ props, children }: A2UIPrimitiveComponentProps) {
  const title = readString(props.title);
  const collapsible = readBoolean(props.collapsible);
  const [collapsed, setCollapsed] = useState(readBoolean(props.defaultCollapsed));

  return (
    <section className="min-w-0 space-y-2 border-t border-zinc-200/80 pt-3 first:border-t-0 first:pt-0 dark:border-zinc-800/80">
      {title ? (
        <div className="flex min-w-0 items-center justify-between gap-3">
          <h2 className="min-w-0 text-[15px] font-semibold leading-6 text-zinc-900 dark:text-zinc-100">
            {title}
          </h2>
          {collapsible ? (
            <button
              type="button"
              aria-expanded={!collapsed}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setCollapsed((current) => !current);
              }}
              className="shrink-0 rounded-full border border-zinc-300 px-2 py-1 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
            >
              {collapsed ? 'Show' : 'Hide'}
            </button>
          ) : null}
        </div>
      ) : null}
      <div className={cn('min-w-0 space-y-2', collapsed && 'hidden')}>{children}</div>
    </section>
  );
}
