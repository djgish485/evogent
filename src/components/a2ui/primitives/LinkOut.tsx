'use client';

import { readString, type A2UIPrimitiveComponentProps } from '../shared';

function parseUrl(value: string | null): URL | null {
  if (!value) {
    return null;
  }
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function LinkOut({ props }: A2UIPrimitiveComponentProps) {
  const href = readString(props.href);
  const parsedUrl = parseUrl(href);
  const text = readString(props.text) ?? parsedUrl?.hostname ?? 'Open link';

  if (!parsedUrl || (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:')) {
    return (
      <span className="inline-flex min-w-0 items-center rounded-full border border-zinc-300 px-2.5 py-1 text-[13px] text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
        <span className="truncate">{text}</span>
      </span>
    );
  }

  const faviconUrl = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(parsedUrl.hostname)}&sz=32`;

  return (
    <a
      href={parsedUrl.toString()}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => event.stopPropagation()}
      className="inline-flex min-w-0 max-w-full items-center gap-2 rounded-full border border-zinc-300 bg-white/70 px-2.5 py-1 text-[13px] font-medium text-zinc-700 transition-colors hover:border-sky-300 hover:text-sky-700 dark:border-zinc-700 dark:bg-zinc-900/50 dark:text-zinc-200 dark:hover:border-sky-700 dark:hover:text-sky-200"
    >
      <img src={faviconUrl} alt="" className="h-4 w-4 shrink-0 rounded-sm" loading="lazy" />
      <span className="min-w-0 truncate">{text}</span>
      <svg aria-hidden="true" viewBox="0 0 20 20" className="h-3.5 w-3.5 shrink-0">
        <path d="M7 4.5h8.5V13h-1.8V7.6l-8 8L4.4 14.3l8-8H7V4.5Z" fill="currentColor" />
      </svg>
    </a>
  );
}
