'use client';

import type { ReactNode } from 'react';
import type { A2UIActionEvent, A2UINode } from './types';

export type A2UITone = 'zinc' | 'rose' | 'blue' | 'purple' | 'teal' | 'amber' | 'green' | 'sky';

export interface A2UIPrimitiveComponentProps {
  node: A2UINode;
  props: Record<string, unknown>;
  children?: ReactNode;
  onAction?: (event: A2UIActionEvent) => void | Promise<void>;
}

export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

export function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function readBoolean(value: unknown): boolean {
  return value === true || (typeof value === 'string' && value.trim().toLowerCase() === 'true');
}

export function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseFloat(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function readNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => readNumber(entry))
    .filter((entry): entry is number => entry !== null);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function normalizeTone(value: unknown, fallback: A2UITone = 'zinc'): A2UITone {
  switch (typeof value === 'string' ? value.trim().toLowerCase() : '') {
    case 'rose':
    case 'red':
      return 'rose';
    case 'blue':
      return 'blue';
    case 'purple':
    case 'violet':
      return 'purple';
    case 'teal':
    case 'cyan':
      return 'teal';
    case 'amber':
    case 'yellow':
      return 'amber';
    case 'green':
    case 'emerald':
      return 'green';
    case 'sky':
      return 'sky';
    case 'zinc':
    case 'gray':
    case 'slate':
      return 'zinc';
    default:
      return fallback;
  }
}

export const toneClassNames: Record<A2UITone, {
  pill: string;
  text: string;
  border: string;
  surface: string;
  ring: string;
}> = {
  zinc: {
    pill: 'border-zinc-300 bg-zinc-100 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900/70 dark:text-zinc-200',
    text: 'text-zinc-600 dark:text-zinc-300',
    border: 'border-zinc-300 dark:border-zinc-700',
    surface: 'bg-zinc-100/80 dark:bg-zinc-900/55',
    ring: 'text-zinc-500 dark:text-zinc-300',
  },
  rose: {
    pill: 'border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-800/70 dark:bg-rose-950/35 dark:text-rose-200',
    text: 'text-rose-600 dark:text-rose-300',
    border: 'border-rose-300 dark:border-rose-800/70',
    surface: 'bg-rose-50/80 dark:bg-rose-950/25',
    ring: 'text-rose-500 dark:text-rose-300',
  },
  blue: {
    pill: 'border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-800/70 dark:bg-blue-950/35 dark:text-blue-200',
    text: 'text-blue-600 dark:text-blue-300',
    border: 'border-blue-300 dark:border-blue-800/70',
    surface: 'bg-blue-50/80 dark:bg-blue-950/25',
    ring: 'text-blue-500 dark:text-blue-300',
  },
  purple: {
    pill: 'border-purple-300 bg-purple-50 text-purple-700 dark:border-purple-800/70 dark:bg-purple-950/35 dark:text-purple-200',
    text: 'text-purple-600 dark:text-purple-300',
    border: 'border-purple-300 dark:border-purple-800/70',
    surface: 'bg-purple-50/80 dark:bg-purple-950/25',
    ring: 'text-purple-500 dark:text-purple-300',
  },
  teal: {
    pill: 'border-teal-300 bg-teal-50 text-teal-700 dark:border-teal-800/70 dark:bg-teal-950/35 dark:text-teal-200',
    text: 'text-teal-600 dark:text-teal-300',
    border: 'border-teal-300 dark:border-teal-800/70',
    surface: 'bg-teal-50/80 dark:bg-teal-950/25',
    ring: 'text-teal-500 dark:text-teal-300',
  },
  amber: {
    pill: 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800/70 dark:bg-amber-950/35 dark:text-amber-200',
    text: 'text-amber-700 dark:text-amber-300',
    border: 'border-amber-300 dark:border-amber-800/70',
    surface: 'bg-amber-50/80 dark:bg-amber-950/25',
    ring: 'text-amber-500 dark:text-amber-300',
  },
  green: {
    pill: 'border-green-300 bg-green-50 text-green-700 dark:border-green-800/70 dark:bg-green-950/35 dark:text-green-200',
    text: 'text-green-600 dark:text-green-300',
    border: 'border-green-300 dark:border-green-800/70',
    surface: 'bg-green-50/80 dark:bg-green-950/25',
    ring: 'text-green-500 dark:text-green-300',
  },
  sky: {
    pill: 'border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-800/70 dark:bg-sky-950/35 dark:text-sky-200',
    text: 'text-sky-600 dark:text-sky-300',
    border: 'border-sky-300 dark:border-sky-800/70',
    surface: 'bg-sky-50/80 dark:bg-sky-950/25',
    ring: 'text-sky-500 dark:text-sky-300',
  },
};
