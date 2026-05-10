'use client';

import { readString, type A2UIPrimitiveComponentProps } from '../shared';

export function Bullet({ props }: A2UIPrimitiveComponentProps) {
  const text = readString(props.text) ?? '';
  const icon = readString(props.icon) ?? readString(props.emoji);

  return (
    <div className="flex min-w-0 items-start gap-2 text-[14px] leading-6 text-zinc-700 dark:text-zinc-300">
      {icon ? (
        <span className="mt-0.5 shrink-0 text-sm leading-5" aria-hidden="true">{icon}</span>
      ) : (
        <span className="mt-[9px] h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-400 dark:bg-zinc-500" aria-hidden="true" />
      )}
      <p className="min-w-0 break-words">{text}</p>
    </div>
  );
}
