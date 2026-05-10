'use client';

import { readString, type A2UIPrimitiveComponentProps } from '../shared';

export function Paragraph({ props }: A2UIPrimitiveComponentProps) {
  const text = readString(props.text) ?? '';

  return (
    <p className="whitespace-pre-wrap break-words text-[14px] leading-6 text-zinc-700 dark:text-zinc-300">
      {text}
    </p>
  );
}
