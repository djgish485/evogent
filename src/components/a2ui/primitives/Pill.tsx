'use client';

import { cn, normalizeTone, readString, toneClassNames, type A2UIPrimitiveComponentProps } from '../shared';

export function Pill({ props }: A2UIPrimitiveComponentProps) {
  const text = readString(props.text) ?? '';
  const tone = normalizeTone(props.color ?? props.tone);

  return (
    <span className={cn('inline-flex max-w-full items-center rounded-full border px-2 py-0.5 text-[11px] font-medium leading-5', toneClassNames[tone].pill)}>
      <span className="min-w-0 truncate">{text}</span>
    </span>
  );
}
