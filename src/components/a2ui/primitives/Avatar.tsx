'use client';

import { cn, normalizeTone, readString, toneClassNames, type A2UIPrimitiveComponentProps } from '../shared';

const sizeClassNames = {
  sm: 'h-7 w-7 text-[11px]',
  md: 'h-9 w-9 text-xs',
  lg: 'h-12 w-12 text-sm',
} as const;

function normalizeSize(value: unknown): keyof typeof sizeClassNames {
  return value === 'sm' || value === 'lg' ? value : 'md';
}

export function Avatar({ props }: A2UIPrimitiveComponentProps) {
  const src = readString(props.src);
  const initials = (readString(props.initials) ?? 'AG').slice(0, 3).toUpperCase();
  const alt = readString(props.alt) ?? initials;
  const size = normalizeSize(props.size);
  const tone = normalizeTone(props.color ?? props.tone, 'zinc');

  if (src) {
    return (
      <img
        src={src}
        alt={alt}
        className={cn('shrink-0 rounded-full border border-zinc-300 object-cover dark:border-zinc-700', sizeClassNames[size])}
        loading="lazy"
      />
    );
  }

  return (
    <span className={cn('inline-flex shrink-0 items-center justify-center rounded-full border font-semibold', sizeClassNames[size], toneClassNames[tone].pill)}>
      {initials}
    </span>
  );
}
