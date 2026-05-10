'use client';

import {
  Bar,
  BarChart as RechartsBarChart,
  ReferenceLine,
  ResponsiveContainer,
  YAxis,
} from 'recharts';
import { cn, normalizeTone, readNumber, readNumberArray, readString, toneClassNames, type A2UIPrimitiveComponentProps } from '../shared';

export function BarChart({ props }: A2UIPrimitiveComponentProps) {
  const data = readNumberArray(props.data);
  const target = readNumber(props.targetLine);
  const label = readString(props.label);
  const tone = normalizeTone(props.color ?? props.tone, 'blue');
  const chartData = data.map((value, index) => ({ index, value }));
  const maxValue = Math.max(...data, target ?? 0, 1);

  if (chartData.length === 0) {
    return <div className="text-xs text-zinc-500 dark:text-zinc-400">No chart data</div>;
  }

  return (
    <div className={cn('min-w-[160px] flex-1', toneClassNames[tone].text)}>
      {label ? <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">{label}</p> : null}
      <div className="h-24 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <RechartsBarChart data={chartData} margin={{ top: 6, right: 8, bottom: 0, left: 8 }}>
            <YAxis hide domain={[0, maxValue]} />
            <Bar dataKey="value" fill="currentColor" radius={[3, 3, 0, 0]} isAnimationActive={false} />
            {target !== null ? (
              <ReferenceLine
                y={target}
                stroke="currentColor"
                strokeDasharray="4 4"
                strokeOpacity={0.7}
                ifOverflow="extendDomain"
              />
            ) : null}
          </RechartsBarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
