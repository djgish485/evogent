'use client';

import { clamp, cn, normalizeTone, readNumber, readString, toneClassNames, type A2UIPrimitiveComponentProps } from '../shared';

export function MetricRing({ props }: A2UIPrimitiveComponentProps) {
  const value = clamp(readNumber(props.value) ?? 0, 0, 100);
  const label = readString(props.label) ?? 'Metric';
  const tone = normalizeTone(props.color ?? props.tone, 'green');
  const radius = 30;
  const strokeWidth = 7;
  const circumference = 2 * Math.PI * radius;
  const progress = circumference * (value / 100);
  const dashOffset = circumference - progress;

  return (
    <div className="flex min-w-[86px] flex-1 flex-col items-center gap-1">
      <svg viewBox="0 0 80 80" className="h-20 w-20 -rotate-90">
        <circle
          cx="40"
          cy="40"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          className="text-zinc-200 dark:text-zinc-800"
        />
        <circle
          cx="40"
          cy="40"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={`${circumference} ${circumference}`}
          strokeDashoffset={dashOffset}
          className={cn('transition-[stroke-dashoffset]', toneClassNames[tone].ring)}
        />
        <text
          x="40"
          y="40"
          dominantBaseline="middle"
          textAnchor="middle"
          className="rotate-90 fill-zinc-900 text-[17px] font-semibold dark:fill-zinc-100"
        >
          {Math.round(value)}
        </text>
      </svg>
      <span className="max-w-full truncate text-center text-xs font-medium text-zinc-500 dark:text-zinc-400">
        {label}
      </span>
    </div>
  );
}
