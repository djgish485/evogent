'use client';

import { cn, readString, type A2UIPrimitiveComponentProps } from '../shared';

function normalizeDirection(value: unknown): 'up' | 'down' | 'flat' {
  return value === 'up' || value === 'down' ? value : 'flat';
}

export function TrendArrow({ props }: A2UIPrimitiveComponentProps) {
  const direction = normalizeDirection(props.direction);
  const delta = readString(props.delta) ?? '';
  const toneClass = direction === 'up'
    ? 'text-green-600 dark:text-green-300'
    : direction === 'down'
      ? 'text-rose-600 dark:text-rose-300'
      : 'text-zinc-500 dark:text-zinc-400';

  return (
    <span className={cn('inline-flex items-center gap-1 text-xs font-semibold', toneClass)}>
      <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5">
        {direction === 'up' ? (
          <path d="M8 3.5 13 9h-3v3.5H6V9H3l5-5.5Z" fill="currentColor" />
        ) : direction === 'down' ? (
          <path d="M8 12.5 3 7h3V3.5h4V7h3l-5 5.5Z" fill="currentColor" />
        ) : (
          <path d="M3 7h10v2H3V7Z" fill="currentColor" />
        )}
      </svg>
      {delta ? <span>{delta}</span> : null}
    </span>
  );
}
