'use client';

import { readString, type A2UIPrimitiveComponentProps } from '../shared';

export function CollapsedCount({ node, props, onAction }: A2UIPrimitiveComponentProps) {
  const label = readString(props.label) ?? '';
  const actionId = readString(props.actionId);

  return (
    <button
      type="button"
      disabled={!actionId}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (actionId) {
          void onAction?.({ actionId, source: 'a2ui', nodeId: node.id });
        }
      }}
      className="inline-flex max-w-full items-center rounded-full border border-zinc-300 bg-zinc-100/80 px-2.5 py-1 text-[12px] font-medium text-zinc-600 transition-colors hover:bg-zinc-200/80 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900/60 dark:text-zinc-300 dark:hover:bg-zinc-800/80"
    >
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}
