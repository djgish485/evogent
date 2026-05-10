'use client';

import { cn, readBoolean, readString, type A2UIPrimitiveComponentProps } from '../shared';

function gapClass(value: string | null): string {
  switch (value) {
    case '1':
    case 'sm':
      return 'gap-1.5';
    case '3':
    case 'lg':
      return 'gap-4';
    case '4':
    case 'xl':
      return 'gap-5';
    default:
      return 'gap-3';
  }
}

function alignClass(value: string | null): string {
  switch (value) {
    case 'start':
      return 'items-start';
    case 'end':
      return 'items-end';
    case 'stretch':
      return 'items-stretch';
    default:
      return 'items-center';
  }
}

function justifyClass(value: string | null): string {
  switch (value) {
    case 'between':
      return 'justify-between';
    case 'end':
      return 'justify-end';
    case 'center':
      return 'justify-center';
    default:
      return 'justify-start';
  }
}

export function Row({ props, children }: A2UIPrimitiveComponentProps) {
  const wrap = props.wrap === undefined ? true : readBoolean(props.wrap);

  return (
    <div className={cn('flex min-w-0', wrap ? 'flex-wrap' : 'overflow-x-auto', gapClass(readString(props.gap)), alignClass(readString(props.align)), justifyClass(readString(props.justify)))}>
      {children}
    </div>
  );
}
