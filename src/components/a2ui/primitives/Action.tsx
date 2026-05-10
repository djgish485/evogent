'use client';

import { normalizeTone, readString, toneClassNames, type A2UIPrimitiveComponentProps } from '../shared';

export function Action({ node, props, onAction }: A2UIPrimitiveComponentProps) {
  const label = readString(props.label) ?? 'Action';
  const actionId = readString(props.actionId);
  const tone = normalizeTone(props.color ?? props.tone, 'sky');

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
      className={`inline-flex min-h-9 max-w-full items-center rounded-full border px-3 py-1.5 text-[13px] font-medium transition-colors hover:bg-white/80 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-zinc-900 ${toneClassNames[tone].pill}`}
    >
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}
