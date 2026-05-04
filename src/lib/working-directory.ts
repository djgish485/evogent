export function formatWorkingDirectoryLabel(pathname: string | null | undefined): string | null {
  if (typeof pathname !== 'string') return null;
  const trimmed = pathname.trim();
  if (!trimmed) return null;

  const normalized = trimmed.replace(/\/+$/, '') || '/';
  const homeRelative = normalized === '/root'
    ? '~'
    : normalized.startsWith('/root/')
      ? `~${normalized.slice('/root'.length)}`
      : normalized;

  if (homeRelative.length <= 32) {
    return homeRelative;
  }

  const parts = homeRelative.split('/').filter(Boolean);
  const basename = parts.at(-1);
  if (!basename) {
    return homeRelative;
  }

  const prefix = homeRelative.startsWith('~/')
    ? '~'
    : homeRelative.startsWith('/')
      ? '/'
      : parts[0];
  return `${prefix}/.../${basename}`;
}
