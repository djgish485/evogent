import { type ChatAttachment } from '@/types/chat';

export function formatChatAttachmentSize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return '0 B';
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${Math.round(size)} B`;
}

export function ChatAttachmentCard({
  attachment,
  compact = false,
  onRemove,
}: {
  attachment: ChatAttachment;
  compact?: boolean;
  onRemove?: (() => void) | null;
}) {
  const isImage = attachment.kind === 'image';

  return (
    <div className={`group relative min-w-0 overflow-hidden rounded-2xl border ${
      compact
        ? 'max-w-[220px] border-zinc-800 bg-zinc-950/80'
        : 'max-w-full border-zinc-700/80 bg-zinc-900/85'
    }`}>
      <a
        href={attachment.previewUrl}
        target="_blank"
        rel="noreferrer"
        className={`flex min-w-0 items-center gap-3 ${compact ? 'p-2' : 'p-2.5'}`}
      >
        {isImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={attachment.previewUrl}
            alt={attachment.originalName}
            className={`${compact ? 'h-12 w-12' : 'h-14 w-14'} shrink-0 rounded-xl border border-white/10 bg-black/30 object-cover`}
          />
        ) : (
          <div className={`${compact ? 'h-12 w-12' : 'h-14 w-14'} flex shrink-0 items-center justify-center rounded-xl border border-white/10 bg-black/30 text-zinc-200`}>
            <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5">
              <path
                d="M7 3h7l5 5v13H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm6 1.5V9h4.5"
                className="fill-none stroke-current"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.8"
              />
            </svg>
          </div>
        )}

        <div className="min-w-0">
          <p className="truncate text-xs font-medium text-zinc-100">{attachment.originalName}</p>
          <p className="mt-0.5 text-[11px] text-zinc-400">
            {attachment.kind === 'image' ? 'Image' : 'File'} · {formatChatAttachmentSize(attachment.size)}
          </p>
        </div>
      </a>

      {onRemove && (
        <button
          type="button"
          aria-label={`Remove attachment ${attachment.originalName}`}
          onClick={onRemove}
          className="absolute right-1.5 top-1.5 inline-flex h-6 w-6 items-center justify-center rounded-full border border-white/10 bg-black/70 text-xs text-zinc-200 transition hover:border-white/20 hover:bg-black/85"
        >
          ×
        </button>
      )}
    </div>
  );
}
