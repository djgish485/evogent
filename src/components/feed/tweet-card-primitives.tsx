import type { ReactNode } from 'react';

function initialsForName(name: string): string {
  const initials = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token[0]?.toUpperCase() ?? '')
    .join('')
    .slice(0, 2);

  return initials || '?';
}

export function formatCompactCount(count: number): string {
  if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}K`;
  return count.toString();
}

export function formatRelativeTimestamp(dateIso: string): string {
  const value = new Date(dateIso);
  if (Number.isNaN(value.getTime())) return 'unknown';

  const diffMs = Date.now() - value.getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;

  return value.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function formatAuthorHandle(username: string): string {
  return username.startsWith('@') ? username : `@${username}`;
}

export function InitialsAvatar({
  name,
  className = '',
  sizeClassName = 'h-11 w-11 sm:h-12 sm:w-12',
  children,
}: {
  name: string;
  className?: string;
  sizeClassName?: string;
  children?: ReactNode;
}) {
  return (
    <div
      className={`flex items-center justify-center rounded-full text-sm font-semibold text-white ${sizeClassName} ${className}`.trim()}
      style={{ backgroundColor: 'var(--initials-avatar-bg, rgb(63 63 70))' }}
    >
      {children ?? initialsForName(name)}
    </div>
  );
}
