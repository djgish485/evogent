'use client';

import {
  Line,
  LineChart,
  ReferenceDot,
  ResponsiveContainer,
} from 'recharts';
import { cn, normalizeTone, readNumber, readNumberArray, readString, toneClassNames, type A2UIPrimitiveComponentProps } from '../shared';

export function Sparkline({ props }: A2UIPrimitiveComponentProps) {
  const data = readNumberArray(props.data);
  const highlight = readNumber(props.highlight);
  const trendLabel = readString(props.trendLabel);
  const tone = normalizeTone(props.color ?? props.tone, 'sky');
  const chartData = data.map((value, index) => ({ index, value }));
  const highlightIndex = highlight !== null && Number.isInteger(highlight) && highlight >= 0 && highlight < chartData.length
    ? highlight
    : chartData.length - 1;
  const highlightEntry = chartData[highlightIndex] ?? null;

  if (chartData.length === 0) {
    return <div className="text-xs text-zinc-500 dark:text-zinc-400">No trend data</div>;
  }

  return (
    <div className={cn('min-w-[120px] flex-1', toneClassNames[tone].text)}>
      {trendLabel ? <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">{trendLabel}</p> : null}
      <div className="h-14 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData} margin={{ top: 6, right: 8, bottom: 6, left: 8 }}>
            <Line
              type="monotone"
              dataKey="value"
              stroke="currentColor"
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
            {highlightEntry ? (
              <ReferenceDot
                x={highlightEntry.index}
                y={highlightEntry.value}
                r={3}
                fill="currentColor"
                stroke="none"
              />
            ) : null}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
